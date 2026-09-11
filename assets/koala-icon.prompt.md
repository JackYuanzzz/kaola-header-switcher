# 考拉图标生成记录

- 用途：有问题找kaola 浏览器扩展图标及弹窗头像。
- 方式：内置 imagegen 生成，不使用 CLI / API fallback。
- 源文件：`koala-icon.png`；透明背景，保留原图。
- 构建：使用 sharp 仅等比缩放到 16 / 32 / 48 / 128 像素，不修改绘画内容。

## 最终提示词

Use case: logo-brand. Asset type: browser extension toolbar icon and popup mascot. Primary request: one extremely cute anime cartoon koala head, friendly and approachable. Subject: a front-facing round grey koala face, oversized fluffy round ears with soft pink inner ears, iconic large charcoal oval nose, shiny simple dark eyes, small happy smile and a little blush. Style: clean kawaii hand-drawn animation illustration, confident chunky dark pencil-like outlines, simple flat colors with minimal soft shading, cohesive with a playful Rough.js sketchbook interface. Composition: square canvas, one centered koala head filling 90% of the canvas with compact silhouette, both ears fully visible, no body, no accessory, no surrounding objects. Background: genuinely transparent alpha, not a checkerboard drawn into the image. Practical constraints: recognizably a koala at 16 and 32 pixels; prioritize a big nose, round ears and bold silhouette, avoid tiny detail and stray marks. No text, no letters, no logo lettering, no watermark.
