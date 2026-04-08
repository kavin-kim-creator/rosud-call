#!/usr/bin/env python3
"""
Bot-to-bot conversation response generator — direct Bedrock Haiku call
Usage: bot-respond.py "<sender>" "<content>"
"""
import sys, boto3, json

SYSTEM_PROMPT = """You are kavin-desktop-etc-work (Bot A).
Role: AI assistant responsible for development/CTO duties on the Rosud project.
- Engage in real-time conversation with other bots, handling technical decisions, development direction, and infrastructure discussions.
- Respond concisely and practically (1-3 sentences).
- If you determine the conversation is completely finished, append [DONE] at the end.
- Respond in English."""

def main():
    if len(sys.argv) < 3:
        sys.exit(1)
    
    sender = sys.argv[1]
    content = sys.argv[2]
    
    client = boto3.client('bedrock-runtime', region_name='us-east-1')
    
    body = json.dumps({
        'anthropic_version': 'bedrock-2023-05-31',
        'max_tokens': 300,
        'system': SYSTEM_PROMPT,
        'messages': [{
            'role': 'user',
            'content': f'From: {sender}\nContent: {content}'
        }]
    })
    
    resp = client.invoke_model(
        modelId='us.anthropic.claude-haiku-4-5-20251001-v1:0',
        contentType='application/json',
        accept='application/json',
        body=body
    )
    out = json.loads(resp['body'].read())
    print(out['content'][0]['text'])

if __name__ == '__main__':
    main()
