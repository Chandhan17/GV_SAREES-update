import { lazy, Suspense, useMemo, useState } from 'react'
import { FALLBACK_IMAGE, getImageUrl } from '../utils/imageHelpers'

const ImageZoom = lazy(() => import('./ImageZoom'))

export default function ImageGallery({ images = [], alt = 'Product image' }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const galleryImages = useMemo(() => {
    const resolvedImages = images.map((image) => getImageUrl(image)).filter(Boolean)
    return resolvedImages.length ? resolvedImages : [FALLBACK_IMAGE]
  }, [images])
  const selectedIndex = Math.min(activeIndex, galleryImages.length - 1)
  const activeImage = galleryImages[selectedIndex]
  const handleSwipe = (direction) => {
    setActiveIndex((current) => (
      direction === 'next'
        ? Math.min(current + 1, galleryImages.length - 1)
        : Math.max(current - 1, 0)
    ))
  }

  return (
    <div className="space-y-4">
      <Suspense fallback={<div className="aspect-[4/5] animate-pulse rounded-[2rem] border border-brand-rose-gold/30 bg-brand-card-white" />}>
        <ImageZoom src={activeImage} alt={alt} onSwipe={handleSwipe} />
      </Suspense>

      <div className="grid grid-cols-4 gap-3">
        {galleryImages.map((image, index) => {
          return (
            <button
              key={`${image}-${index}`}
              type="button"
              onClick={() => setActiveIndex(index)}
              aria-label={`View product image ${index + 1}`}
              aria-pressed={selectedIndex === index}
              className={`overflow-hidden rounded-xl border-2 ${
                selectedIndex === index ? 'border-brand-rose-gold' : 'border-transparent'
              } focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-rose-gold`}
            >
              <img
                src={image}
                alt={`Product image ${index + 1}`}
                className="aspect-square w-full object-cover"
                loading="lazy"
                onError={(event) => {
                  event.currentTarget.onerror = null
                  event.currentTarget.src = FALLBACK_IMAGE
                }}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
