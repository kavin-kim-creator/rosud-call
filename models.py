from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# --- Bot ---

class BotRegisterRequest(BaseModel):
    bot_id: str = Field(..., min_length=1, max_length=100)
    display_name: str = Field(..., min_length=1, max_length=200)
    tg_token: Optional[str] = Field(default=None, max_length=200)
    tg_group: Optional[str] = Field(default=None, max_length=50)


class BotRegisterResponse(BaseModel):
    bot_id: str
    api_key: str
    display_name: str


class BotProfileResponse(BaseModel):
    bot_id: str
    display_name: str
    tg_token: Optional[str] = None
    tg_group: Optional[str] = None


class BotProfileUpdateRequest(BaseModel):
    tg_token: Optional[str] = Field(default=None, max_length=200)
    tg_group: Optional[str] = Field(default=None, max_length=50)


# --- Room ---

class RoomCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    room_type: str = Field(default="group")
    max_turns: Optional[int] = Field(default=None, ge=0)
    member_ids: list[str] = Field(default_factory=list)


class RoomResponse(BaseModel):
    id: UUID
    name: str
    room_type: str
    max_turns: Optional[int]
    turn_count: int
    status: str
    created_by: str
    created_at: datetime
    closed_at: Optional[datetime] = None


class AddMemberRequest(BaseModel):
    member_id: str


# --- Message ---

class MessageHistoryItem(BaseModel):
    id: UUID
    room_id: UUID
    sender_id: str
    sender_type: str
    content: str
    content_type: str
    metadata: Optional[dict[str, Any]] = None
    created_at: datetime


class MessageHistoryResponse(BaseModel):
    messages: list[MessageHistoryItem]
    has_more: bool


# --- WebSocket Events (TypedDict) ---

from typing import TypedDict


class WSSendMessage(TypedDict):
    type: str        # "send_message"
    room_id: str
    content: str
    content_type: str
    metadata: dict[str, Any]


class WSSubscribe(TypedDict):
    type: str        # "subscribe"
    room_id: str


class WSUnsubscribe(TypedDict):
    type: str        # "unsubscribe"
    room_id: str


class WSMessageNew(TypedDict):
    type: str        # "message_new"
    message: dict[str, Any]


class WSMessageSent(TypedDict):
    type: str        # "message_sent"
    message_id: str
    room_id: str


class WSRoomClosed(TypedDict):
    type: str        # "room_closed"
    room_id: str
    reason: str


class WSError(TypedDict):
    type: str        # "error"
    code: str
    message: str


class WSPong(TypedDict):
    type: str        # "pong"
