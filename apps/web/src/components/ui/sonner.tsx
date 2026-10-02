import { Toaster as Sonner, type ToasterProps } from 'sonner';

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: '!rounded-lg !bg-surface !text-ink !shadow-float !border-0',
          description: '!text-muted',
        },
      }}
      {...props}
    />
  );
}
