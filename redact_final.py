from PIL import Image, ImageDraw

img = Image.open('/tmp/openclaw.png')
draw = ImageDraw.Draw(img)

# Row 1: Kobold
draw.rectangle([88, 130, 400, 150], fill="black")
# Row 2: RentalClaw
draw.rectangle([122, 190, 400, 210], fill="black")
# Row 3: TiLT Claw
draw.rectangle([109, 250, 400, 270], fill="black")
# Row 4: Volta
draw.rectangle([73, 310, 400, 330], fill="black")

img.save('website/public/screenshots/open claw integration.png')
