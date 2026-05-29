from dotenv import load_dotenv
import os

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes.invoices import router as invoices_router

app = FastAPI(
    title="TallyAI Backend",
    description="Cloud backend for TallyAI — AI-powered Tally integration",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(invoices_router, prefix="/invoices")

@app.get("/")
def root():
    return {"status": "TallyAI backend running"}

@app.get("/health")
def health():
    return {"status": "ok"}
