/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#fdf6ee',
          100: '#f9e8cf',
          200: '#f2cc96',
          300: '#eaaa57',
          400: '#e48f30',
          500: '#d97318',
          600: '#c05a13',
          700: '#9f4213',
          800: '#813416',
          900: '#6a2c15',
        },
        surface: {
          50:  '#f9f7f4',
          100: '#f0ebe3',
          200: '#e3d9cc',
          300: '#d1c2ad',
          400: '#bba48e',
          500: '#a68a73',
          600: '#927561',
          700: '#796151',
          800: '#645146',
          900: '#54453d',
        }
      },
      fontFamily: {
        sans: ['DM Sans', 'sans-serif'],
        display: ['Fraunces', 'serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
