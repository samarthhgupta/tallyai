"""
TallyAI Agent
-------------
Runs on the customer's Tally PC.
Connects to TallyAI cloud and pushes approved entries into Tally.

Setup:
1. Install Python on the Tally PC
2. pip install -r requirements.txt
3. Add your AGENT_TOKEN to config.env
4. Run: python agent.py

The agent will run silently in the background.
It connects outward to TallyAI cloud — no firewall changes needed.
"""

import asyncio
import json
import httpx
import websockets
from dotenv import load_dotenv
import os

load_dotenv("config.env")

AGENT_TOKEN = os.getenv("AGENT_TOKEN")
CLOUD_URL = os.getenv("CLOUD_URL", "wss://api.tallyai.in/agent/connect")
TALLY_URL = os.getenv("TALLY_URL", "http://localhost:9000")


async def push_to_tally(xml_data: str) -> dict:
    """Send XML voucher to Tally via its built-in XML API"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                TALLY_URL,
                content=xml_data,
                headers={"Content-Type": "application/xml"},
                timeout=30
            )
            return {"success": True, "response": response.text}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def connect_to_cloud():
    """Maintain persistent connection to TallyAI cloud"""
    print("TallyAI Agent starting...")
    print(f"Connecting to cloud: {CLOUD_URL}")

    while True:
        try:
            async with websockets.connect(
                CLOUD_URL,
                extra_headers={"Authorization": f"Bearer {AGENT_TOKEN}"}
            ) as ws:
                print("Connected to TallyAI cloud. Waiting for entries...")

                async for message in ws:
                    data = json.loads(message)

                    if data["type"] == "push_voucher":
                        print(f"Received voucher: {data['invoice_id']}")
                        result = await push_to_tally(data["xml"])

                        await ws.send(json.dumps({
                            "type": "push_result",
                            "invoice_id": data["invoice_id"],
                            "success": result["success"],
                            "error": result.get("error")
                        }))

                        if result["success"]:
                            print(f"Entry pushed successfully: {data['invoice_id']}")
                        else:
                            print(f"Push failed: {result['error']}")

        except Exception as e:
            print(f"Connection lost: {e}. Reconnecting in 10 seconds...")
            await asyncio.sleep(10)


if __name__ == "__main__":
    asyncio.run(connect_to_cloud())
