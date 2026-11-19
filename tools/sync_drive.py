#!/usr/bin/env python3
"""
Ambil daftar video dari Google Drive (folder + Starred) lalu simpan ke videos.json.
Website membaca videos.json, jadi pengunjung tidak memanggil Drive API sama sekali.

Pemakaian:
    pip install -r tools/requirements.txt
    python tools/sync_drive.py

Login pertama kali akan membuka browser (sekali per akun). Setelah itu token
disimpan di tools/token_<nama>.json dan dipakai ulang otomatis.
"""
import json
import os
import re
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SCOPES = ["https://www.googleapis.com/auth/drive.metadata.readonly"]
FOLDER = "application/vnd.google-apps.folder"
SHORTCUT = "application/vnd.google-apps.shortcut"
FIELDS = ("nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,"
          "videoMediaMetadata(durationMillis),shortcutDetails(targetId,targetMimeType))")
MEDIA_Q = f"(mimeType contains 'video/' or mimeType = '{FOLDER}' or mimeType = '{SHORTCUT}')"


def folder_id(s: str) -> str:
    """Terima ID saja atau link folder lengkap."""
    s = s.strip()
    m = re.search(r"/folders/([^/?#]+)", s) or re.search(r"[?&]id=([^&#]+)", s)
    return m.group(1) if m else s


def env_name(name: str) -> str:
    return "GDRIVE_TOKEN_" + re.sub(r"[^A-Z0-9]", "_", name.upper())


def get_creds(name: str) -> Credentials:
    token_path = HERE / f"token_{name}.json"
    env_token = os.environ.get(env_name(name))  # dipakai di GitHub Actions
    creds = None
    if env_token:
        creds = Credentials.from_authorized_user_info(json.loads(env_token), SCOPES)
    elif token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except Exception as e:
            print(f"  Token akun '{name}' tidak bisa diperbarui: {e}")
            creds = None

    if not creds or not creds.valid:
        if env_token or os.environ.get("CI"):
            sys.exit(f"Token akun '{name}' tidak valid. Jalankan script ini di komputer untuk login ulang, "
                     f"lalu perbarui secret {env_name(name)}.")
        secrets = HERE / "credentials.json"
        if not secrets.exists():
            sys.exit("File tools/credentials.json belum ada. Download OAuth Client ID (Desktop app) "
                     "dari Google Cloud Console dan simpan dengan nama itu.")
        print(f"\n>> Login Google untuk akun '{name}' (browser akan terbuka)."
              f"\n   Pilih akun Google yang sesuai untuk '{name}'.")
        flow = InstalledAppFlow.from_client_secrets_file(str(secrets), SCOPES)
        # select_account: selalu tampilkan pilihan akun, supaya akun kedua tidak otomatis memakai akun pertama
        creds = flow.run_local_server(port=0, prompt="select_account consent", access_type="offline")

    if not env_token:
        token_path.write_text(creds.to_json(), encoding="utf-8")
    return creds


def list_all(svc, q: str) -> list:
    out, token = [], None
    while True:
        res = svc.files().list(q=q, fields=FIELDS, pageSize=1000, pageToken=token,
                               supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
        out += res.get("files", [])
        token = res.get("nextPageToken")
        if not token:
            return out


def is_video(f: dict) -> bool:
    if f["mimeType"].startswith("video/"):
        return True
    return f["mimeType"] == SHORTCUT and f.get("shortcutDetails", {}).get("targetMimeType", "").startswith("video/")


def to_video(f: dict, cat):
    sc = f["mimeType"] == SHORTCUT
    dur = f.get("videoMediaMetadata", {}).get("durationMillis")
    return {
        "id": f["shortcutDetails"]["targetId"] if sc else f["id"],
        "name": re.sub(r"\.[a-z0-9]{2,4}$", "", f["name"], flags=re.I),
        "cat": cat,
        "created": f.get("createdTime", ""),
        "modified": f.get("modifiedTime") or f.get("createdTime", ""),
        "dur": int(dur) if dur else 0,
        "thumb": "",  # website memakai drive.google.com/thumbnail?id=... (link publik)
    }


class Library:
    def __init__(self, fav_names):
        self.videos, self.fav, self.cats = {}, set(), set()
        self.src = {}          # id video -> nama playlist (folder asal)
        self.fav_names = [n.lower() for n in fav_names]

    def add(self, v, in_fav=False, playlist=None):
        if in_fav:
            self.fav.add(v["id"])
        if playlist and v["id"] not in self.src:
            self.src[v["id"]] = playlist
        old = self.videos.get(v["id"])
        if not old:
            self.videos[v["id"]] = v
        else:
            if not old["cat"] and v["cat"]:
                old["cat"] = v["cat"]
            if not old["dur"]:
                old["dur"] = v["dur"]
        if v["cat"]:
            self.cats.add(v["cat"])

    def walk(self, svc, fid, cat=None, in_fav=False, depth=0, playlist=None):
        for f in list_all(svc, f"'{fid}' in parents and trashed = false and {MEDIA_Q}"):
            if f["mimeType"] == FOLDER:
                if depth >= 3:
                    continue
                if depth == 0 and f["name"].strip().lower() in self.fav_names:
                    self.walk(svc, f["id"], None, True, depth + 1, playlist)
                else:
                    self.walk(svc, f["id"], f["name"] if depth == 0 else cat, in_fav, depth + 1, playlist)
            elif is_video(f):
                self.add(to_video(f, cat), in_fav, playlist)

    def starred(self, svc):
        q = f"starred = true and trashed = false and (mimeType contains 'video/' or mimeType = '{SHORTCUT}')"
        outside = 0
        for f in list_all(svc, q):
            if not is_video(f):
                continue
            v = to_video(f, None)
            if v["id"] not in self.videos:
                outside += 1
            self.add(v, in_fav=True)
        return outside


def main():
    cfg_path = HERE / "sync_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    lib = Library(cfg.get("favorite_folder_names", ["favorit", "favorite"]))
    total_outside = 0

    seen_emails = {}
    playlist_order = []
    accounts_info = []
    for acc in cfg["accounts"]:
        name = acc["name"]
        svc = build("drive", "v3", credentials=get_creds(name), cache_discovery=False)
        about = svc.about().get(fields="user(emailAddress),storageQuota(limit,usage,usageInDrive)").execute()
        email = about.get("user", {}).get("emailAddress", "?")
        print(f"Akun '{name}' = {email}")
        if email in seen_emails:
            print(f"  PERINGATAN: '{name}' login dengan email yang sama seperti '{seen_emails[email]}'.\n"
                  f"  Hapus file tools/token_{name}.json lalu jalankan ulang, dan pilih akun Google yang lain.")
            continue
        seen_emails[email] = name
        q = about.get("storageQuota", {})
        accounts_info.append({"email": email, "usage": int(q.get("usage", 0)),
                              "drive": int(q.get("usageInDrive", 0)),
                              "limit": int(q["limit"]) if q.get("limit") else None})
        gb = lambda b: f"{b / 1024**3:.1f} GB"
        print(f"  penyimpanan: {gb(int(q.get('usage', 0)))} dari {gb(int(q['limit'])) if q.get('limit') else 'tak terbatas'}")
        for item in acc.get("folders", []):
            # folder bisa ditulis sebagai link saja, atau {"link": ..., "playlist": "Nama playlist"}
            link = item["link"] if isinstance(item, dict) else item
            fid = folder_id(link)
            pl = item.get("playlist") if isinstance(item, dict) else None
            if not pl:
                # nama playlist = email pemilik folder (kalau tidak terbaca, pakai email akun yang login)
                meta = svc.files().get(fileId=fid, fields="name,owners(emailAddress)", supportsAllDrives=True).execute()
                owners = meta.get("owners") or []
                pl = owners[0].get("emailAddress") if owners and owners[0].get("emailAddress") else email
            if pl not in playlist_order:
                playlist_order.append(pl)
            before = len(lib.videos)
            lib.walk(svc, fid, playlist=pl)
            print(f"  folder {fid} -> playlist '{pl}': +{len(lib.videos) - before} video")
        if acc.get("use_starred", True):
            before = len(lib.fav)
            out = lib.starred(svc)
            total_outside += out
            print(f"  starred: +{len(lib.fav) - before} video favorit")

    videos = sorted(({**v, "cat": v["cat"] or "Others"} for v in lib.videos.values()), key=lambda v: v["id"])
    cats = sorted(lib.cats, key=str.lower)
    if any(v["cat"] == "Others" for v in videos) and cats:
        cats.append("Others")
    newest = sorted(videos, key=lambda v: v.get("modified") or v.get("created") or "", reverse=True)
    playlists = [{"name": pl, "ids": [v["id"] for v in newest if lib.src.get(v["id"]) == pl]} for pl in playlist_order]
    from datetime import datetime, timezone
    data = {"videos": videos, "fav": sorted(lib.fav), "cats": cats, "playlists": playlists,
            "accounts": accounts_info, "synced": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    out_path = ROOT / cfg.get("output", "videos.json")
    out_path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\nSelesai: {len(videos)} video, {len(lib.fav)} favorit, {len(cats)} kategori, "
          f"{len(playlists)} playlist -> {out_path.name}")
    if total_outside:
        print(f"Catatan: {total_outside} video berbintang ada di luar folder di atas. "
              f"Pastikan video itu di-share 'Anyone with the link' supaya bisa diputar di website.")


if __name__ == "__main__":
    main()