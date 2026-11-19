# Membuat ikon aplikasi Android dari icons/icon-512.png dan icons/maskable-512.png.
# Dijalankan otomatis oleh GitHub Actions saat build APK (butuh: pip install pillow).
import os, sys
from PIL import Image, ImageDraw

res = sys.argv[1] if len(sys.argv) > 1 else "android/app/src/main/res"
icon = Image.open("icons/icon-512.png").convert("RGBA")
mask_icon = Image.open("icons/maskable-512.png").convert("RGBA")
dens = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

for name, f in dens.items():
    d = os.path.join(res, f"mipmap-{name}")
    os.makedirs(d, exist_ok=True)
    n = int(48 * f)
    icon.resize((n, n), Image.LANCZOS).save(os.path.join(d, "ic_launcher.png"))
    sq = mask_icon.resize((n, n), Image.LANCZOS)
    m = Image.new("L", (n, n), 0); ImageDraw.Draw(m).ellipse([0, 0, n - 1, n - 1], fill=255)
    rnd = Image.new("RGBA", (n, n), (0, 0, 0, 0)); rnd.paste(sq, (0, 0), m)
    rnd.save(os.path.join(d, "ic_launcher_round.png"))
    fg = int(108 * f)
    mask_icon.resize((fg, fg), Image.LANCZOS).save(os.path.join(d, "ic_launcher_foreground.png"))

os.makedirs(os.path.join(res, "values"), exist_ok=True)
with open(os.path.join(res, "values", "ic_launcher_background.xml"), "w") as fh:
    fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#DADBEA</color>\n</resources>\n')

# splash: latar gelap polos (tidak gepeng di layar mana pun)
for root, _, files in os.walk(res):
    if "splash.png" in files:
        p = os.path.join(root, "splash.png")
        w, h = Image.open(p).size
        Image.new("RGB", (w, h), (14, 14, 16)).save(p)
print("Ikon & splash Android siap di", res)
