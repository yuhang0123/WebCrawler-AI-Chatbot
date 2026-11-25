from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from model import answer_question
import logging


app = FastAPI()
logging.basicConfig(level=logging.INFO)


# CORS Configuration
allowed_origins=[
    "http://127.0.0.1:8000"
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_headers=["*"],
    allow_methods=["*"],
    expose_headers=["X-Request-ID"]
)

@app.put("/inquiry")
def process(
    question: str,
    page_content: str,
    url: str
):
    return answer_question(question=question, page_content=page_content)

