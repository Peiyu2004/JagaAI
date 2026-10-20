// PLACEHOLDER — not the vendor component.
// Replace this whole file with the TechText source (minus 'use client', with the
// detection-label edit) once it is supplied. It only renders the static wordmark
// so the rest of the login can be reviewed.
import './TechText.css';

export default function TechText({
  text = '',
  fontFamily,
  fontWeight,
  fontSize = 220,
  letterSpacing = 0,
  color,
  align = 'center',
  className = '',
  style
}) {
  return (
    <div className={`tech-text ${className}`.trim()} style={style}>
      <svg viewBox={`0 0 ${fontSize * text.length * 0.62} ${fontSize * 1.2}`} width="100%" height="100%">
        <text
          x={align === 'left' ? '0' : align === 'right' ? '100%' : '50%'}
          y="50%"
          dominantBaseline="central"
          textAnchor={align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'}
          fill={color}
          style={{ fontFamily, fontWeight, fontSize, letterSpacing: `${letterSpacing}em` }}
        >
          {text}
        </text>
      </svg>
    </div>
  );
}
