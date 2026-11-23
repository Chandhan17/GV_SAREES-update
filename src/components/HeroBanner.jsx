import { ArrowRight } from 'lucide-react'
import { motion as Motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import clientConfig from '../config/clientConfig'
import { FALLBACK_IMAGE } from '../utils/imageHelpers'

export default function HeroBanner() {
  return (
    <section className="relative h-[320px] overflow-hidden bg-brand-blush sm:aspect-[1672/941] sm:h-auto">
      <img
        src={clientConfig.heroImages[0]}
        alt="GV Sarees collection"
        className="absolute inset-0 h-full w-full object-cover object-[70%_center] sm:object-contain sm:object-center"
        onError={(event) => {
          event.currentTarget.onerror = null
          event.currentTarget.src = FALLBACK_IMAGE
        }}
      />
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
