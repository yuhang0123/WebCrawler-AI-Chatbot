import hashlib
import logging
import os
import re
import threading
from collections import OrderedDict
from functools import cache

from dotenv import load_dotenv
from langchain_core.vectorstores import InMemoryVectorStore
from langchain_openai import OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv()
logger = logging.getLogger(__name__)

CHUNK_SIZE = 1000          # characters per chunk
CHUNK_OVERLAP = 150        # shared characters between neighbouring chunks
TOP_K = 5                  # chunks sent to the LLM
FETCH_K = 20               # candidates considered before MMR picks the final TOP_K
MAX_CACHED_PAGES = 20      # how many pages' vector stores we keep in memory

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")

# define queries that require to send entire page for ai prompt, not using rag
# to provide a more appropriate answer
_WHOLE_PAGE_PATTERN = re.compile(
    r"\b(summar(?:y|ize|ise|ies)|tl;?dr|overview|gist|"
    r"(?:main|key) (?:points?|ideas?|takeaways?)|"
    r"what(?:'s| is) (?:this|the) (?:page|article|post|site|website|document) about)\b",
    re.IGNORECASE,
)

_cache: "OrderedDict[str, InMemoryVectorStore]" = OrderedDict()
_lock = threading.Lock()

@cache
def _get_embeddings():
    return OpenAIEmbeddings(model=EMBEDDING_MODEL)

"""
Function to get hash of page content as key in vector store
"""
def _page_key(page_content):
    return hashlib.sha256(page_content.encode("utf-8")).hexdigest()

"""
Function to build InMemoryVectorStore for page content
"""
def _build_store(page_content):
    # split the content into chunk
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        add_start_index=True # remember each chunk's position in the page
    )

    docs = splitter.create_documents([page_content]) # create a list of Document objects from a "list" of texts
    store = InMemoryVectorStore(_get_embeddings()) # in memory store via dict, use numpy to compute consine similarity for search
    store.add_documents(docs)

    logger.info("Indexed page: %d chars -> %d chunks", len(page_content), len(docs))
    return store

"""
Check if page content has been hashed before.
Return the hashed key if True; else build a hash and keep in vector store
"""
def _get_store (page_content):
    key = _page_key(page_content)

    with _lock:
        store = _cache.get(key)
        if store is not None:
            # LRU (Least Recently Used) cache
            _cache.move_to_end(key)
            logger.info("Cache hit for page %s", key[:8])
            return store

    store = _build_store(page_content)

    with _lock:
        # check if another request cache the same page content and finish first
        existing = _cache.get(key)
        if existing is not None:
            return existing

        _cache[key] = store
        while len(_cache) > MAX_CACHED_PAGES:
            _cache.popitem(last=False)

    return store

"""
Return the page text the LLM should see for the question
"""
def get_context(question, page_content):
    require_whole_page = bool(_WHOLE_PAGE_PATTERN.search(question))

    if require_whole_page:
        reason = "whole-page question"
        logger.info("Sending full page (%s)", reason)
        return page_content

    store = _get_store(page_content)
    retriever = store.as_retriever(
        search_type="mmr", # relevance + diversity
        search_kwargs={"k": TOP_K, "fetch_k": FETCH_K}
    )
    docs = retriever.invoke(question)
    docs.sort(key=lambda d: d.metadata.get("start_index", 0))

    # for log
    for i, doc in enumerate(docs, 1):
        preview = doc.page_content[:80].replace("\n", " ")
        logger.info("Retrieved #%d (pos %s): %s...", i, doc.metadata.get("start_index"), preview)

    # for formatted context returned
    return "\n\n".join(f"[Excerpt {i}]\n{doc.page_content}" for i, doc in enumerate(docs, 1))

