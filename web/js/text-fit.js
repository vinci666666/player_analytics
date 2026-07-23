/**
 * 指標卡文字自動縮放。 / Automatic metric-card text fitting.
 * ResizeObserver 處理容器尺寸，MutationObserver 處理資料刷新後的文字變更。
 * ResizeObserver tracks container size; MutationObserver tracks refreshed text.
 */

const DEFAULT_MIN_SIZE = 10;

/** 將單一元素縮小到可容納寬度，但不低於下限。 / Shrink one element to fit without crossing the minimum size. */
function fitElement(element, minSize) {
  if (!element.isConnected || element.clientWidth <= 0) return;

  if (!element.dataset.fitMaxSize) {
    element.dataset.fitMaxSize = String(parseFloat(getComputedStyle(element).fontSize));
  }

  const maxSize = Number(element.dataset.fitMaxSize);
  element.style.fontSize = `${maxSize}px`;

  const availableWidth = element.clientWidth;
  const requiredWidth = element.scrollWidth;
  if (requiredWidth <= availableWidth) return;

  const fittedSize = Math.max(minSize, Math.floor(maxSize * availableWidth / requiredWidth * 10) / 10);
  element.style.fontSize = `${fittedSize}px`;
}

/** 安裝批次化觀察器並回傳清理函式。 / Install batched observers and return a cleanup function. */
export function installAutoFitText(selector, options = {}) {
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
  const elements = [...document.querySelectorAll(selector)];
  const pending = new Set(elements);
  let animationFrame = null;

  const flush = () => {
    animationFrame = null;
    pending.forEach(element => fitElement(element, minSize));
    pending.clear();
  };

  const schedule = element => {
    pending.add(element);
    if (animationFrame === null) animationFrame = requestAnimationFrame(flush);
  };

  const resizeObserver = new ResizeObserver(entries => {
    entries.forEach(entry => schedule(entry.target));
  });
  const mutationObserver = new MutationObserver(mutations => {
    mutations.forEach(mutation => schedule(mutation.target.nodeType === Node.TEXT_NODE
      ? mutation.target.parentElement
      : mutation.target));
  });

  elements.forEach(element => {
    resizeObserver.observe(element);
    mutationObserver.observe(element, { childList: true, characterData: true, subtree: true });
    schedule(element);
  });

  return () => {
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  };
}
