from PIL import Image

img = Image.open('/tmp/openclaw.png')

rows = [(134, 146), (194, 205), (253, 265), (312, 323)]

for r_start, r_end in rows:
    # Scan horizontally to find the gap between name and IP
    gap_start = -1
    for x in range(50, 400):
        # Check if column x is entirely black in this row range
        is_empty = True
        for y in range(r_start-2, r_end+2):
            if y >= img.height: continue
            r, g, b, _ = img.getpixel((x, y)) if img.mode == 'RGBA' else (*img.getpixel((x, y)), 255)
            if r > 20 or g > 20 or b > 20:
                is_empty = False
                break
        
        if is_empty:
            if gap_start == -1:
                gap_start = x
            else:
                # If we have a gap of at least 5 pixels, this is it!
                if x - gap_start >= 5:
                    print(f"Row {r_start}-{r_end}: Gap starts at {gap_start}, IP starts around {x}")
                    break
        else:
            gap_start = -1

