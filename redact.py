from PIL import Image, ImageDraw

img = Image.open('website/public/screenshots/open claw integration.png')
draw = ImageDraw.Draw(img)

# The list of servers is on the left.
# x=120 to x=380, y=100 to 300
draw.rectangle([110, 110, 400, 310], fill="black")

img.save('website/public/screenshots/open claw integration.png')
