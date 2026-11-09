import { computed, nextTick, onUpdated, reactive, ref, watch, type Ref } from 'vue'
import './content-zoom.css'

export const MIN_CONTENT_ZOOM = 0.55
export const MAX_CONTENT_ZOOM = 1.6

interface Point {
  x: number
  y: number
}

interface Pinch {
  ids: [number, number]
  distance: number
  zoom: number
  anchor: Point
}

export function useContentZoom(
  viewport: Ref<HTMLElement | undefined>,
  surface: Ref<HTMLElement | undefined>,
  zoom: Ref<number> = ref(1),
  options: { size?: () => { width: number; height: number } | undefined; fillHeight?: boolean } = {},
) {
  const viewportSize = ref({ width: 0, height: 0 })
  const surfaceSize = reactive({ width: 0, height: 0 })
  const minimumHeight = computed(() => options.fillHeight ? viewportSize.value.height / Math.min(1, zoom.value) : 0)
  const fixedSize = computed(() => options.size?.())
  const size = computed(() => fixedSize.value ?? {
    width: Math.max(viewportSize.value.width, surfaceSize.width),
    height: Math.max(surfaceSize.height, minimumHeight.value),
  })
  const extentStyle = computed(() => ({
    width: `${size.value.width * zoom.value}px`,
    height: `${size.value.height * zoom.value}px`,
  }))
  const surfaceStyle = computed(() => ({
    width: `${fixedSize.value?.width ?? viewportSize.value.width}px`,
    height: fixedSize.value ? `${fixedSize.value.height}px` : undefined,
    transform: `scale(${zoom.value})`,
    '--content-zoom-min-height': `${minimumHeight.value}px`,
  }))

  function measureSurface() {
    const content = surface.value
    if (!content) return
    // Deep outline rows can overflow horizontally without changing the surface's border box.
    surfaceSize.width = content.scrollWidth
    surfaceSize.height = Math.max(content.scrollHeight, Math.ceil(content.getBoundingClientRect().height / zoom.value))
  }

  onUpdated(measureSurface)

  function contentPoint(point: Point): Point {
    const rect = surface.value!.getBoundingClientRect()
    return { x: (point.x - rect.left) / zoom.value, y: (point.y - rect.top) / zoom.value }
  }

  async function setZoom(value: number, point?: Point, anchor?: Point) {
    const container = viewport.value
    const content = surface.value
    if (!container || !content) return
    const rect = container.getBoundingClientRect()
    const center = point ?? {
      x: rect.left + container.clientLeft + container.clientWidth / 2,
      y: rect.top + container.clientTop + container.clientHeight / 2,
    }
    const origin = anchor ?? contentPoint(center)
    zoom.value = Math.min(MAX_CONTENT_ZOOM, Math.max(MIN_CONTENT_ZOOM, value))
    await nextTick()
    // A view switch can replace the scroll container while Vue updates the scale.
    if (viewport.value !== container || surface.value !== content) return
    const scaled = content.getBoundingClientRect()
    container.scrollLeft += scaled.left + origin.x * zoom.value - center.x
    container.scrollTop += scaled.top + origin.y * zoom.value - center.y
  }

  watch([viewport, surface], ([container, content], _previous, onCleanup) => {
    if (!container || !content) return
    const padding = getComputedStyle(container)
    viewportSize.value = {
      width: container.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight),
      height: container.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom),
    }
    measureSurface()
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === container) {
          viewportSize.value = { width: entry.contentRect.width, height: entry.contentRect.height }
        }
      }
      measureSurface()
    })
    observer.observe(container)
    observer.observe(content)

    let owned = false
    let pinch: Pinch | undefined
    let suppressClickUntil = 0

    const localTouches = (event: TouchEvent) => Array.from(event.touches)
      .filter(touch => container.contains(touch.target as Node))
    const midpoint = (first: Touch, second: Touch): Point => ({
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2,
    })
    const distance = (first: Touch, second: Touch) => Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)

    function consume(event: TouchEvent) {
      if (event.cancelable) event.preventDefault()
      event.stopPropagation()
    }

    function startPinch(touches: Touch[]) {
      const [first, second] = touches as [Touch, Touch]
      pinch = {
        ids: [first.identifier, second.identifier],
        distance: Math.max(1, distance(first, second)),
        zoom: zoom.value,
        anchor: contentPoint(midpoint(first, second)),
      }
    }

    function onTouchStart(event: TouchEvent) {
      const touches = localTouches(event)
      if (!owned && touches.length < 2) {
        suppressClickUntil = 0
        return
      }
      owned = true
      consume(event)
      if (touches.length === 2) startPinch(touches)
      else pinch = undefined
    }

    function onTouchMove(event: TouchEvent) {
      if (!owned) return
      consume(event)
      const touches = localTouches(event)
      if (touches.length !== 2) {
        pinch = undefined
        return
      }
      const first = touches.find(touch => touch.identifier === pinch?.ids[0])
      const second = touches.find(touch => touch.identifier === pinch?.ids[1])
      if (!pinch || !first || !second) {
        startPinch(touches)
        return
      }
      void setZoom(pinch.zoom * distance(first, second) / pinch.distance, midpoint(first, second), pinch.anchor)
    }

    function onTouchEnd(event: TouchEvent) {
      if (!owned) return
      consume(event)
      suppressClickUntil = performance.now() + 500
      const touches = localTouches(event)
      pinch = undefined
      if (event.type === 'touchcancel' || touches.length === 0) owned = false
      else if (touches.length === 2) startPinch(touches)
    }

    function onClick(event: MouseEvent) {
      if (event.detail && (owned || performance.now() < suppressClickUntil)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }

    // Only a multi-touch sequence is canceled; native one-finger scrolling and editing stay intact.
    const touchOptions = { capture: true, passive: false }
    container.addEventListener('touchstart', onTouchStart, touchOptions)
    container.addEventListener('touchmove', onTouchMove, touchOptions)
    container.addEventListener('touchend', onTouchEnd, touchOptions)
    container.addEventListener('touchcancel', onTouchEnd, touchOptions)
    container.addEventListener('click', onClick, true)
    onCleanup(() => {
      observer.disconnect()
      container.removeEventListener('touchstart', onTouchStart, true)
      container.removeEventListener('touchmove', onTouchMove, true)
      container.removeEventListener('touchend', onTouchEnd, true)
      container.removeEventListener('touchcancel', onTouchEnd, true)
      container.removeEventListener('click', onClick, true)
    })
  }, { flush: 'post' })

  return { zoom, extentStyle, surfaceStyle, setZoom }
}
