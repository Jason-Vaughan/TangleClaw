from PIL import Image

img = Image.open('/tmp/openclaw.png')
pixels = img.load()

# Find rows that contain non-black pixels between x=20 and x=50
rows_with_text = []
for y in range(80, 320):
    has_text = False
    for x in range(20, 50):
        r, g, b, _ = img.getpixel((x, y)) if img.mode == 'RGBA' else (*img.getpixel((x, y)), 255)
        if r > 50 or g > 50 or b > 50:
            has_text = True
            break
    if has_text:
        rows_with_text.append(y)

import itertools
ranges = []
for k, g in itertools.groupby(enumerate(rows_with_text), lambda ix : ix[0] - ix[1]):
    group = list(map(lambda ix : ix[1], g))
    ranges.append((group[0], group[-1]))

print(ranges)
