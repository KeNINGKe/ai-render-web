// 浏览器与命令行共用的通用提示词；不引用产品目录。
export function buildSeedreamRenderPrompt({
  productPrompt = "",
  cameraView = "",
  applicationScene = "",
  designLanguage = "",
  material = "",
  color = "",
  userNotes = "",
  avoidNotes = "",
  extraNotes = "",
  hasStructureImage = false
} = {}) {
  return [
    productPrompt,
    "以参考图为权威几何来源：为这台能源装备生成照片级、可量产工艺水准的产品渲染图。",
    "严格保持参考图的外轮廓、整体比例与画面宽高比——不得拉伸、压扁、裁切、加宽或收窄设备。",
    "构图与取景完全复刻参考图：主体在画面中的占比、四周留白与地平线位置保持不变；禁止推近镜头、禁止特写式放大主体、禁止重新取景。",
    "面板分缝、舱门、冲孔通风阵列、开口、紧固件、指示灯、控制按钮、底盘、支腿与安全硬件的位置一律保持原样。",
    cameraView ? `机位与视角要求：${cameraView}。` : "",
    applicationScene ? `应用场景：${applicationScene}。` : "",
    designLanguage ? `设计语言：${designLanguage}。` : "",
    material ? `主体材质与表面处理：${material}。` : "",
    color ? `色彩方向：${color}。` : "",
    "采用真实尺度的工业光照与人体尺度的制造细节：真实的喷涂钢板、镀锌底盘与量产级面板缝隙。",
    "品牌标识、装饰色条与 Logo 位置保持不变；不得凭空新增 Logo，不得出现无法辨认的假标签、装饰性假通风口或多出/缺失的舱门。",
    hasStructureImage
      ? "另附线稿/结构参考图作为权威几何来源：严格按其外轮廓、比例、面板分缝、舱门位置、开口与部件布局执行，不得相对线稿增删、移动或改形任何结构元素。"
      : "",
    avoidNotes
      ? `严格回避清单——渲染结果中不得出现以下任何内容：${avoidNotes}；以上元素需完全排除在画面之外。`
      : "",
    userNotes ? `用户要求：${userNotes}。` : "",
    extraNotes ? `工程附加要求：${extraNotes}。` : ""
  ].filter(Boolean).join(" ");
}

// 局部重绘提示词：配合「整图重绘 + 前端蒙版合成回贴」管线使用。
// Seedream/SeedEdit 的 API 都没有 mask 参数，所以 mask 不进 API：
// 模型整图重生成，前端再把未涂抹区域的原始像素回贴覆盖。
// 提示词因此强调「除目标区域外一切保持原样」，减轻边界衔接突兀。
export function buildInpaintPrompt({ instruction = "" } = {}) {
  return [
    "对提供的图像做局部编辑：只重绘编辑指令所描述的区域。",
    "编辑区之外的每个像素保持不变：构图、外轮廓与比例、机位视角、光照方向与强度、背景均与原图一致，未触碰表面的颜色与材质完全相同。",
    "不得在编辑区之外增删、移动或改形任何部件；重绘区域需与周边自然衔接、无明显边界。",
    instruction ? `编辑指令：${instruction}。` : ""
  ].filter(Boolean).join(" ");
}
