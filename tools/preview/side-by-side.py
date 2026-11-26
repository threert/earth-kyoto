# before.png after.png out.jpg title: the two stills side by side, labelled.
import sys
from PIL import Image, ImageDraw, ImageFont

a, b = Image.open(sys.argv[1]).convert("RGB"), Image.open(sys.argv[2]).convert("RGB")
w, h = a.size
out = Image.new("RGB", (w * 2 + 8, h), (20, 20, 20))
out.paste(a, (0, 0))
out.paste(b.resize((w, h)), (w + 8, 0))
d = ImageDraw.Draw(out)
try:
    f = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 28)
except Exception:
    f = ImageFont.load_default()
for x, label in ((16, f"{sys.argv[4]}: before (the trunk)"), (w + 24, f"{sys.argv[4]}: after (threert/earth-kyoto)")):
    d.text((x + 2, 14), label, fill=(0, 0, 0), font=f)
    d.text((x, 12), label, fill=(255, 255, 255), font=f)
out.save(sys.argv[3], quality=90)
