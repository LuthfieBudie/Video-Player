#!/usr/bin/env python3
"""
Optimalkan video sebelum di-upload ke Google Drive, supaya cepat diputar di Video Gallery.

Yang dilakukan ke setiap video:
  - diubah ke MP4 (H.264 + AAC)  -> format yang pasti bisa diputar player "Smooth" & Shorts
  - sisi terpanjang maksimal 1280 px (720p)  -> ukuran file jauh lebih kecil
  - "faststart": info video ditaruh di depan file -> video bisa mulai SEBELUM selesai diunduh

Pemakaian (di terminal, dari folder project):
    pip install imageio-ffmpeg
    python tools/optimize_videos.py "D:\\Video Mentah"
    python tools/optimize_videos.py "D:\\Video Mentah" --out "D:\\Siap Upload" --size 1080 --crf 24

Hasilnya ada di folder output (default: <folder input>\\optimized). Upload file hasil itu ke Google Drive.
"""
import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".3gp", ".wmv", ".flv", ".mpg", ".mpeg", ".ts"}


def find_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg tidak ditemukan. Jalankan dulu:  pip install imageio-ffmpeg")


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def optimize(ffmpeg: str, src: Path, dst: Path, size: int, crf: int) -> bool:
    # sisi terpanjang maksimal `size`*16/9 (720 -> 1280, 1080 -> 1920), tidak memperbesar video kecil
    long_side = round(size * 16 / 9 / 2) * 2
    scale = (f"scale=w='if(gt(iw,ih),min({long_side},iw),-2)':"
             f"h='if(gt(iw,ih),-2,min({long_side},ih))'")
    tmp = dst.with_suffix(".part.mp4")
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-stats", "-y",
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", scale,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p",
        "-profile:v", "high", "-level", "4.1",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-movflags", "+faststart",
        str(tmp),
    ]
    result = subprocess.run(cmd)
    if result.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(dst)
    return True


def main():
    ap = argparse.ArgumentParser(description="Optimalkan video untuk Video Gallery (MP4, 720p, faststart).")
    ap.add_argument("input", help="folder berisi video asli")
    ap.add_argument("--out", help="folder hasil (default: <input>/optimized)")
    ap.add_argument("--size", type=int, default=720, choices=[480, 720, 1080], help="resolusi (default 720)")
    ap.add_argument("--crf", type=int, default=26, help="kualitas: angka kecil = lebih bagus & lebih besar (default 26)")
    ap.add_argument("--force", action="store_true", help="proses ulang walaupun hasilnya sudah ada")
    args = ap.parse_args()

    src_dir = Path(args.input).expanduser().resolve()
    if not src_dir.is_dir():
        sys.exit(f"Folder tidak ditemukan: {src_dir}")
    out_dir = Path(args.out).expanduser().resolve() if args.out else src_dir / "optimized"
    out_dir.mkdir(parents=True, exist_ok=True)

    ffmpeg = find_ffmpeg()
    files = sorted(p for p in src_dir.rglob("*")
                   if p.is_file() and p.suffix.lower() in VIDEO_EXT and out_dir not in p.parents)
    if not files:
        sys.exit("Tidak ada video di folder itu.")

    print(f"{len(files)} video ditemukan -> hasil di: {out_dir}\n")
    total_before = total_after = 0
    done = skipped = failed = 0
    t0 = time.time()

    for n, src in enumerate(files, 1):
        rel = src.relative_to(src_dir).with_suffix(".mp4")
        dst = out_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists() and not args.force and dst.stat().st_mtime >= src.stat().st_mtime:
            skipped += 1
            print(f"[{n}/{len(files)}] lewati (sudah ada): {rel}")
            continue
        print(f"[{n}/{len(files)}] {src.name} ({human(src.stat().st_size)})")
        if optimize(ffmpeg, src, dst, args.size, args.crf):
            before, after = src.stat().st_size, dst.stat().st_size
            total_before += before
            total_after += after
            done += 1
            print(f"    -> {human(after)}  ({(1 - after / before) * 100:.0f}% lebih kecil)\n" if before else "")
        else:
            failed += 1
            print("    -> GAGAL (file mungkin rusak)\n")

    mins = (time.time() - t0) / 60
    print(f"Selesai dalam {mins:.1f} menit: {done} diproses, {skipped} dilewati, {failed} gagal.")
    if total_before:
        print(f"Ukuran total: {human(total_before)} -> {human(total_after)} "
              f"(hemat {(1 - total_after / total_before) * 100:.0f}%).")
    print(f"\nUpload isi folder ini ke Google Drive:\n  {out_dir}")


if __name__ == "__main__":
    main()