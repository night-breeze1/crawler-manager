from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import List, Optional, Dict, Any


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@dataclass
class VersionInfo:
    version: str
    created_at: str
    description: str
    file_count: int = 0
    total_size: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "VersionInfo":
        return cls(
            version=data["version"],
            created_at=data.get("created_at", ""),
            description=data.get("description", ""),
            file_count=data.get("file_count", 0),
            total_size=data.get("total_size", 0),
        )


@dataclass
class ProjectMeta:
    name: str
    description: str
    created_at: str
    updated_at: str
    current_version: Optional[str] = None
    versions: List[VersionInfo] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "current_version": self.current_version,
            "versions": [v.to_dict() for v in self.versions],
            "tags": self.tags,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ProjectMeta":
        return cls(
            name=data["name"],
            description=data.get("description", ""),
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
            current_version=data.get("current_version"),
            versions=[VersionInfo.from_dict(v) for v in data.get("versions", [])],
            tags=data.get("tags", []),
        )