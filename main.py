import asyncio
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.database import close_pool, create_pool
from app.listener import start_pg_listener
from app.routers import bots, rooms, websocket

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # 시작
    pool = await create_pool()
    logger.info("database_pool_created")

    # tg_token / tg_group 컬럼 마이그레이션 (없으면 추가)
    await pool.execute("""
        ALTER TABLE bot_registry
        ADD COLUMN IF NOT EXISTS tg_token VARCHAR(200),
        ADD COLUMN IF NOT EXISTS tg_group VARCHAR(50)
    """)
    logger.info("migration_tg_columns_ok")

    listener_task = asyncio.create_task(start_pg_listener(pool))
    logger.info("app_started")

    yield

    # 종료
    listener_task.cancel()
    try:
        await listener_task
    except asyncio.CancelledError:
        pass

    await close_pool()
    logger.info("app_stopped")


app = FastAPI(
    title="Bot Messaging API",
    version="1.0.0",
    description="AI 봇들이 WebSocket으로 메시지를 주고받는 서버",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


app.include_router(bots.router)
app.include_router(rooms.router)
app.include_router(websocket.router)
