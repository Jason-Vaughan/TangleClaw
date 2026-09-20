from PIL import Image, ImageDraw

img = Image.open('website/public/screenshots/open claw integration.png')
draw = ImageDraw.Draw(img)

# Row 1: Kobold
draw.rectangle([65, 135, 300, 155], fill="red")
# Row 2: RentalClaw
draw.rectangle([85, 185, 350, 205], fill="red")
# Row 3: TiLT Claw
draw.rectangle([78, 235, 350, 255], fill="red")
# Row 4: Volta
draw.rectangle([53, 285, 300, 305], fill="red")

img.save('website/public/screenshots/open claw integration.png')
