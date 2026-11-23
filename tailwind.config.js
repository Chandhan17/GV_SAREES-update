/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Playfair Display"', 'serif'],
        body: ['"DM Sans"', 'sans-serif'],
      },
      colors: {
        'brand-soft-white': 'rgb(var(--color-soft-white-rgb) / <alpha-value>)',
        'brand-blush': 'rgb(var(--color-light-blush-rgb) / <alpha-value>)',
        'brand-pale-rose': 'rgb(var(--color-pale-rose-rgb) / <alpha-value>)',
        'brand-rose-gold': 'rgb(var(--color-rose-gold-rgb) / <alpha-value>)',
        'brand-dusty': 'rgb(var(--color-dusty-rose-rgb) / <alpha-value>)',
        'brand-burgundy': 'rgb(var(--color-burgundy-rgb) / <alpha-value>)',
        'brand-white': 'rgb(var(--color-white-rgb) / <alpha-value>)',
        'brand-secondary': 'rgb(var(--color-secondary-rgb) / <alpha-value>)',
        'brand-button-text': 'rgb(var(--color-button-text-rgb) / <alpha-value>)',
        'brand-accent': 'rgb(var(--color-rose-gold-rgb) / <alpha-value>)',
        'brand-card-white': 'rgb(var(--color-card-white-rgb) / <alpha-value>)',
      },
      boxShadow: {
        soft: '0 12px 40px rgba(146, 113, 108, 0.08)',
        elevated: '0 16px 44px rgba(146, 113, 108, 0.14)',
        royal: '0 20px 52px rgba(146, 113, 108, 0.22)',
      },
      backgroundImage: {
        brocade:
          'radial-gradient(circle at 20% 10%, rgba(216,173,165,0.18) 0, rgba(216,173,165,0) 36%), radial-gradient(circle at 80% 90%, rgba(146,113,108,0.14) 0, rgba(146,113,108,0) 40%)',
      },
    },
  },
  plugins: [],
}
