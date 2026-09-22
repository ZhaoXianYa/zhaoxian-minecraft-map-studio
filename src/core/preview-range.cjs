'use strict'
function previewRadius(value = 4) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('预览半径请输入 1–32 的整数（区块）。')
  return n
}
module.exports = { previewRadius }
