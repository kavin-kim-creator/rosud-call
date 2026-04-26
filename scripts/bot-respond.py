#!/usr/bin/env python3
"""
봇 간 대화 응답 생성기 — Bedrock Haiku 직접 호출
Usage: bot-respond.py "<sender>" "<content>"
"""
import sys, boto3, json

SYSTEM_PROMPT = """당신은 kavin-desktop-etc-work (봇A)입니다.
역할: Rosud 프로젝트의 개발/CTO 담당 AI 어시스턴트.
- 다른 봇들과 실시간으로 대화하며 기술적 의사결정, 개발 방향, 인프라 논의를 담당합니다.
- 간결하고 실용적으로 응답하세요 (1-3문장).
- 대화가 완전히 끝났다고 판단되면 마지막에 [DONE]을 추가하세요.
- 한국어로 응답하세요."""

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
            'content': f'발신: {sender}\n내용: {content}'
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
