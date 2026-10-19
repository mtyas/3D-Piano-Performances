from pathlib import Path
from PIL import Image, ImageDraw
import subprocess
root=Path(__file__).resolve().parent
folder=root/'build'/'Performer.iconset';folder.mkdir(parents=True,exist_ok=True)
im=Image.new('RGBA',(1024,1024),(0,0,0,0));d=ImageDraw.Draw(im)
d.rounded_rectangle((36,36,988,988),radius=216,fill='#171e29',outline='#374252',width=10)
for x,y,color in [(280,370,'#a9c6d1'),(512,620,'#b3c6b5'),(744,450,'#e5b67b')]:
 d.rounded_rectangle((x-12,210,x+12,814),radius=12,fill='#090e15')
 for tick in range(230,815,72):d.line((x+38,tick,x+58,tick),fill='#586477',width=7)
 d.rounded_rectangle((x-62,y-72,x+62,y+72),radius=16,fill=color,outline='#0a111b',width=8)
 d.line((x-48,y,x+48,y),fill='#243346',width=10)
for size in [16,32,128,256,512]:
 for scale in [1,2]:im.resize((size*scale,size*scale),Image.Resampling.LANCZOS).save(folder/f'icon_{size}x{size}{"@2x" if scale==2 else ""}.png')
im.save(root/'shell'/'performer.icns', format='ICNS')
