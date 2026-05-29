# TallyAI Agent — Setup Guide

This is the bridge between TallyAI and your Tally software.
Install this once on the computer where Tally is installed.

---

## One-Time Setup (5 minutes)

### Step 1: Install Python
Download from https://python.org/downloads
During install — check "Add Python to PATH"

### Step 2: Download the Agent
Download the TallyAI Agent from your dashboard.
Extract it to a folder, for example: C:\TallyAI-Agent

### Step 3: Add Your Token
- Open config.env.example
- Rename it to config.env
- Paste your Agent Token from the TallyAI dashboard

### Step 4: Install and Run
Open CMD in the agent folder and run:

```
pip install -r requirements.txt
python agent.py
```

You should see: "Connected to TallyAI cloud. Waiting for entries..."

### Step 5: Enable Tally XML API
In TallyPrime:
- Go to Help → Settings → Connectivity
- Enable "TallyPrime Server"
- Port should be 9000 (default)

---

## That's It

The agent runs in the background.
Every time you approve an invoice on TallyAI, it will automatically appear in Tally.

---

## Troubleshooting

**"Connection lost" message:**
Check your internet connection. The agent will reconnect automatically.

**"Push failed" message:**
Make sure Tally is open and running on the same computer.

**Agent not starting:**
Make sure your AGENT_TOKEN in config.env is correct.
