import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, type ReactNode } from 'react';

export default function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  const isWide = typeof window !== 'undefined' && window.innerWidth >= 720;
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.div
            className="sheet" role="dialog" aria-modal="true" aria-label={title}
            initial={reduce ? { opacity: 0 } : isWide ? { opacity: 0, scale: 0.96, x: '-50%', y: '-50%' } : { y: '100%' }}
            animate={reduce ? { opacity: 1 } : isWide ? { opacity: 1, scale: 1, x: '-50%', y: '-50%' } : { y: 0 }}
            exit={reduce ? { opacity: 0 } : isWide ? { opacity: 0, scale: 0.96, x: '-50%', y: '-50%' } : { y: '100%' }}
            transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
            drag={!isWide && !reduce ? 'y' : false} dragConstraints={{ top: 0 }} dragElastic={0.08}
            onDragEnd={(_, info) => { if (info.offset.y > 120 || info.velocity.y > 600) onClose(); }}
          >
            <div className="grabber" />
            {title && <h2 style={{ marginBottom: 12 }}>{title}</h2>}
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
