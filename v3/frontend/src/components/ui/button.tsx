import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
const buttonVariants=cva('btn inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-50',{variants:{variant:{default:'btn-primary',secondary:'btn-secondary',outline:'btn-outline',ghost:'btn-ghost',destructive:'btn-danger'},size:{default:'',sm:'btn-sm',icon:'btn-icon'}},defaultVariants:{variant:'default',size:'default'}});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>,VariantProps<typeof buttonVariants>{asChild?:boolean}
export function Button({className,variant,size,asChild=false,...props}:ButtonProps){const Comp=asChild?Slot:'button';return <Comp className={cn(buttonVariants({variant,size,className}))} {...props}/>}
