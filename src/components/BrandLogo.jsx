import clientConfig from '../config/clientConfig'

export default function BrandLogo({ alt, className = '', loading = 'eager' }) {
  return (
    <img
      src={clientConfig.logo}
      alt={alt}
      width={112}
      height={112}
      loading={loading}
      className={`block object-contain ${className}`}
      onError={(event) => {
        const image = event.currentTarget
        if (image.getAttribute('src') === clientConfig.logoFallback) {
          image.onerror = null
          return
        }
        image.src = clientConfig.logoFallback
      }}
    />
  )
}
