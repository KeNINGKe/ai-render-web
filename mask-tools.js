function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("无法生成 Mask 图片"));
    }, "image/png");
  });
}

function drawStroke(context, stroke, color) {
  if (!stroke.points.length) return;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = stroke.size;
  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (let index = 1; index < stroke.points.length; index += 1) {
    context.lineTo(stroke.points[index].x, stroke.points[index].y);
  }
  context.stroke();
}

export async function makeWhiteMaskBlob(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvasBlob(canvas);
}

export function createMaskController({ canvas, preview, brushInput }) {
  let strokes = [];
  let uploadedBlob = null;
  let drawing = false;
  let currentStroke = null;

  const syncDisplay = () => {
    if (!preview.naturalWidth) return;
    const rect = preview.getBoundingClientRect();
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  };

  const redraw = () => {
    if (uploadedBlob) return;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) {
      drawStroke(context, stroke, "rgba(255, 40, 40, 0.85)");
    }
  };

  const reset = () => {
    strokes = [];
    uploadedBlob = null;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
  };

  const setSourceDimensions = (width, height) => {
    canvas.width = width;
    canvas.height = height;
    reset();
    syncDisplay();
  };

  const toCanvasPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  };

  const brushSize = () => {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width ? canvas.width / rect.width : 1;
    return Number(brushInput.value) * scale;
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (uploadedBlob) return;
    canvas.setPointerCapture(event.pointerId);
    drawing = true;
    const point = toCanvasPoint(event);
    currentStroke = { size: brushSize(), points: [point] };
    drawStroke(canvas.getContext("2d"), currentStroke, "rgba(255, 40, 40, 0.85)");
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing || !currentStroke) return;
    currentStroke.points.push(toCanvasPoint(event));
    redraw();
    drawStroke(canvas.getContext("2d"), currentStroke, "rgba(255, 40, 40, 0.85)");
  });

  const finishStroke = () => {
    if (!drawing || !currentStroke) return;
    drawing = false;
    strokes.push(currentStroke);
    currentStroke = null;
    redraw();
  };

  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  window.addEventListener("resize", syncDisplay);

  return {
    reset,
    setSourceDimensions,
    syncDisplay,
    undo() {
      if (uploadedBlob || !strokes.length) return;
      strokes.pop();
      redraw();
    },
    async getBlob() {
      if (uploadedBlob) return uploadedBlob;
      if (!strokes.length) return null;
      const mask = document.createElement("canvas");
      mask.width = canvas.width;
      mask.height = canvas.height;
      const context = mask.getContext("2d");
      context.fillStyle = "#000000";
      context.fillRect(0, 0, mask.width, mask.height);
      for (const stroke of strokes) drawStroke(context, stroke, "#ffffff");
      return canvasBlob(mask);
    },
    async loadFile(file, sourceWidth, sourceHeight) {
      const image = new Image();
      const objectUrl = URL.createObjectURL(file);
      try {
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error("无法读取 Mask 图片"));
          image.src = objectUrl;
        });
        if (image.naturalWidth !== sourceWidth || image.naturalHeight !== sourceHeight) {
          throw new Error(
            `Mask 必须与产品图尺寸一致：产品图 ${sourceWidth}×${sourceHeight}，Mask ${image.naturalWidth}×${image.naturalHeight}`
          );
        }
        uploadedBlob = file;
        strokes = [];
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.globalAlpha = 0.5;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        context.globalAlpha = 1;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
  };
}
