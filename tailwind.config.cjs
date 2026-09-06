const { colors, tokens } = require('./scripts/theme-palette.cjs');

module.exports = {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      backgroundColor: ({ theme }) => colors('surface', theme('colors')),
      gradientColorStops: ({ theme }) => colors('surface', theme('colors')),
      textColor: ({ theme }) => colors('text', theme('colors')),
      placeholderColor: ({ theme }) => colors('text', theme('colors')),
      borderColor: ({ theme }) => colors('edge', theme('colors')),
      divideColor: ({ theme }) => colors('edge', theme('colors')),
      ringColor: ({ theme }) => colors('edge', theme('colors')),
      ringOffsetColor: ({ theme }) => colors('surface', theme('colors')),
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'sans-serif'],
      },
    },
  },
  plugins: [({ addBase, theme }) => addBase({
    'html[data-theme="dark"]': tokens(theme('colors'), true),
    // Print always uses ink on paper, including from dark mode.
    '@media print': { 'html[data-theme]': tokens(theme('colors'), false) },
  })],
};
