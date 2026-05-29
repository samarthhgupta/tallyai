from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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

# Routes will be added here as we build
# from routes import invoices, companies, agent, auth
# app.include_router(auth.router, prefix="/auth")
# app.include_router(companies.router, prefix="/companies")
# app.include_router(invoices.router, prefix="/invoices")
# app.include_router(agent.router, prefix="/agent")

@app.get("/")
def root():
    return {"status": "TallyAI backend running"}

@app.get("/health")
def health():
    return {"status": "ok"}
