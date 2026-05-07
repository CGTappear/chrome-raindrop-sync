from PIL import Image, ImageDraw, ImageFont

def create_icon(size, filename):
    # 创建蓝色背景
    img = Image.new('RGB', (size, size), color='#1a73e8')
    draw = ImageDraw.Draw(img)

    # 计算字体大小
    font_size = int(size * 0.6)

    try:
        # 尝试使用系统字体
        font = ImageFont.truetype("arial.ttf", font_size)
    except:
        # 如果找不到，使用默认字体
        font = ImageFont.load_default()

    # 绘制白色的 "R" 字母
    text = "R"

    # 获取文本边界框以居中
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]

    position = ((size - text_width) // 2, (size - text_height) // 2 - bbox[1])

    draw.text(position, text, fill='white', font=font)

    # 保存图标
    img.save(filename, 'PNG')
    print(f"创建图标: {filename}")

# 创建三个尺寸的图标
create_icon(16, 'icons/icon16.png')
create_icon(48, 'icons/icon48.png')
create_icon(128, 'icons/icon128.png')

print("所有图标创建完成！")
