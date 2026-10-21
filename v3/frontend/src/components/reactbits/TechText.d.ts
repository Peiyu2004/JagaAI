import type * as React from "react";

export interface TechTextProps {
  text?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  letterSpacing?: number;
  color?: string;
  accentColor?: string;
  align?: "left" | "center" | "right";
  reveal?: "letter" | "area";
  lineStyle?: "dashed" | "solid";
  dashLength?: number;
  dashGap?: number;
  strokeWidth?: number;
  specks?: number;
  selection?: boolean;
  labels?: boolean;
  draggable?: boolean;
  bounce?: number;
  sweep?: boolean;
  speed?: number;
  clickKick?: boolean;
  intro?: "none" | "type" | "assemble" | "metrics";
  introDuration?: number;
  guides?: boolean;
  reach?: number;
  softness?: number;
  className?: string;
  style?: React.CSSProperties;
}

declare const TechText: React.FC<TechTextProps>;
export default TechText;
