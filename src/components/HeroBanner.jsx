import { ArrowRight } from 'lucide-react'
import { motion as Motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import clientConfig from '../config/clientConfig'
import { FALLBACK_IMAGE } from '../utils/imageHelpers'

export default function HeroBanner() {
  return (
    <section className="relative h-[320px] overflow-hidden bg-brand-blush sm:aspect-[1672/941] sm:h-auto">
      <picture className="absolute inset-0 block">
        <source
          type="image/avif"
          srcSet="/Banner-480.avif 480w, /Banner-960.avif 960w, /Banner-1200.avif 1200w, /Banner-1672.avif 1672w"
          sizes="100vw"
        />
        <source
          type="image/webp"
          srcSet="/Banner-480.webp 480w, /Banner-960.webp 960w, /Banner-1200.webp 1200w, /Banner-1672.webp 1672w"
          sizes="100vw"
        />
        <img
          src={clientConfig.heroImages[0]}
          alt="GV Sarees collection"
          width={1672}
          height={941}
          loading="eager"
          fetchPriority="high"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover object-[70%_center] sm:object-contain sm:object-center"
          onError={(event) => {
            const image = event.currentTarget
            const sources = image.parentElement?.querySelectorAll('source')
            if (sources?.length) {
              sources.forEach((source) => source.remove())
              image.src = clientConfig.heroImages[0]
              return
            }
            image.onerror = null
            image.src = FALLBACK_IMAGE
          }}
        />
      </picture>
      <div className="absolute inset-0 z-0 bg-gradient-to-l from-brand-burgundy/75 via-brand-burgundy/25 to-transparent sm:bg-gradient-to-r sm:from-brand-burgundy/75 sm:via-brand-burgundy/30 sm:to-transparent" />
      <Motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7 }}
        className="relative z-10 mx-auto flex h-full max-w-[1440px] items-center justify-end px-4 py-5 sm:justify-start sm:px-6 sm:py-10 lg:px-10 lg:py-16"
      >
        <div className="relative z-10 max-w-[17rem] px-0 py-4 text-right text-brand-soft-white sm:max-w-xl sm:px-0 sm:py-0 sm:text-left">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand-blush">{clientConfig.content.heroEyebrow}</p>
          <h1 className="mt-2 font-display text-3xl leading-[1.05] text-brand-white sm:mt-4 sm:text-7xl">{clientConfig.content.heroTitle}</h1>
          <p className="mt-3 max-w-md text-xs leading-5 text-brand-white sm:mt-5 sm:text-sm sm:leading-6">{clientConfig.content.heroDescription}</p>
          <Link to="/products" className="btn-gold mt-4 bg-brand-rose-gold text-brand-button-text hover:bg-brand-card-white sm:mt-7">
            Shop all collections <ArrowRight size={16} />
          </Link>
        </div>
      </Motion.div>
    </section>
  )
}
