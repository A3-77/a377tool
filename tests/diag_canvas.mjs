// 诊断：是 canvas 不工作，还是 pdf.js 没画上去
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');

function ink(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
  }
  return n;
}

const c = createCanvas(100, 100);
const ctx = c.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, 100, 100);
console.log('画白底后  墨迹:', ink(c));

ctx.fillStyle = '#000000';
ctx.fillRect(10, 10, 50, 50);
console.log('画黑方块后墨迹:', ink(c), '(期望 2500)');

ctx.font = '30px sans-serif';
ctx.fillStyle = '#ff0000';
ctx.fillText('ABC', 5, 90);
console.log('写文字后  墨迹:', ink(c), '(应该更多)');

// 检查 pdf.js 渲染需要的方法是否齐全
const need = ['save','restore','transform','setTransform','beginPath','moveTo','lineTo',
  'curveTo','closePath','fill','stroke','clip','fillRect','strokeRect','clearRect',
  'scale','translate','rotate','setLineWidth','setLineCap','setLineJoin','setDash',
  'setMiterLimit','setFillRGBColor','setStrokeRGBColor','setFillGray','setStrokeGray',
  'fillText','measureText','createImageData','getImageData','putImageData','drawImage',
  'setLineDash','globalAlpha','globalCompositeOperation','bezierCurveTo','quadraticCurveTo',
  'arc','rect','ellipse','isPointInPath'];
const missing = need.filter((m) => ctx[m] === undefined);
console.log('context 缺失的方法/属性:', missing.length ? missing : '无');
