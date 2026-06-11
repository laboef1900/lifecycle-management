import { useEffect } from 'react';
import { useReducedMotion, useSpring, useTransform } from 'motion/react';
import * as m from 'motion/react-m';

export interface AnimatedNumberProps {
  value: number;
  /** Formats the in-flight value each frame; defaults to locale-rounded integer. */
  format?: (value: number) => string;
  className?: string;
}

const defaultFormat = (v: number): string => Math.round(v).toLocaleString('en-US');

export function AnimatedNumber({
  value,
  format = defaultFormat,
  className,
}: AnimatedNumberProps): React.JSX.Element {
  const reduced = useReducedMotion();
  const spring = useSpring(value, { stiffness: 140, damping: 24 });
  useEffect(() => {
    spring.set(value);
  }, [spring, value]);
  const text = useTransform(spring, format);
  if (reduced) {
    return <span className={className}>{format(value)}</span>;
  }
  return <m.span className={className}>{text}</m.span>;
}
