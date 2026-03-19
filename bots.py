import hashlib
import secrets

import structlog
from fastapi import APIRouter, Depends, HTTPException, status

from app.auth import get_admin, get_current_bot
from app.database import get_pool
from app.models import (
    BotProfileResponse,
    BotProfileUpdateRequest,
    BotRegisterRequest,
    BotRegisterResponse,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/api/bots", tags=["bots"])


@router.post("", response_model=BotRegisterResponse, status_code=status.HTTP_201_CREATED)
async def register_bot(
    body: BotRegisterRequest,
    _: bool = Depends(get_admin),
) -> BotRegisterResponse:
    pool = get_pool()

    # bot_id 중복 확인
    existing = await pool.fetchrow(
        "SELECT bot_id FROM bot_registry WHERE bot_id = $1",
        body.bot_id,
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "CONFLICT", "message": f"bot_id '{body.bot_id}'는 이미 존재합니다"},
        )

    # API 키 생성 및 해시
    raw_key = secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()

    await pool.execute(
        """
        INSERT INTO bot_registry (bot_id, display_name, api_key_hash, is_active, tg_token, tg_group)
        VALUES ($1, $2, $3, TRUE, $4, $5)
        """,
        body.bot_id,
        body.display_name,
        key_hash,
        body.tg_token,
        body.tg_group,
    )

    logger.info("bot_registered", bot_id=body.bot_id, display_name=body.display_name)

    return BotRegisterResponse(
        bot_id=body.bot_id,
        api_key=raw_key,
        display_name=body.display_name,
    )


@router.get("/me", response_model=BotProfileResponse)
async def get_bot_profile(
    bot_id: str = Depends(get_current_bot),
) -> BotProfileResponse:
    """현재 인증된 봇의 프로필 조회 (tg_token, tg_group 포함)"""
    pool = get_pool()

    row = await pool.fetchrow(
        "SELECT bot_id, display_name, tg_token, tg_group FROM bot_registry WHERE bot_id = $1",
        bot_id,
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "봇을 찾을 수 없습니다"},
        )

    return BotProfileResponse(
        bot_id=row["bot_id"],
        display_name=row["display_name"],
        tg_token=row["tg_token"],
        tg_group=row["tg_group"],
    )


@router.patch("/me", response_model=BotProfileResponse)
async def update_bot_profile(
    body: BotProfileUpdateRequest,
    bot_id: str = Depends(get_current_bot),
) -> BotProfileResponse:
    """현재 인증된 봇의 tg_token / tg_group 업데이트"""
    pool = get_pool()

    row = await pool.fetchrow(
        """
        UPDATE bot_registry
        SET
            tg_token = COALESCE($2, tg_token),
            tg_group = COALESCE($3, tg_group)
        WHERE bot_id = $1
        RETURNING bot_id, display_name, tg_token, tg_group
        """,
        bot_id,
        body.tg_token,
        body.tg_group,
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "봇을 찾을 수 없습니다"},
        )

    logger.info("bot_profile_updated", bot_id=bot_id)

    return BotProfileResponse(
        bot_id=row["bot_id"],
        display_name=row["display_name"],
        tg_token=row["tg_token"],
        tg_group=row["tg_group"],
    )


@router.post("/me/rotate-key")
async def rotate_api_key(
    bot_id: str = Depends(get_current_bot),
) -> dict:
    """API Key 재발급 — 현재 인증된 봇 전용"""
    pool = get_pool()

    new_key = secrets.token_urlsafe(32)
    new_hash = hashlib.sha256(new_key.encode()).hexdigest()

    await pool.execute(
        "UPDATE bot_registry SET api_key_hash = $1 WHERE bot_id = $2",
        new_hash, bot_id,
    )

    logger.info("api_key_rotated", bot_id=bot_id)

    return {
        "bot_id": bot_id,
        "api_key": new_key,
        "message": "API Key가 재발급되었습니다. 즉시 .secrets에 저장하세요.",
    }
