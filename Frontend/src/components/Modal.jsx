// src/components/Modal.jsx
export default function Modal({ open, onClose, title, children, size }) {
  if (!open) return null;

  const maxW = size === "xl" ? "max-w-6xl" : "max-w-5xl";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm p-0 sm:p-4 md:p-6 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className={`mx-auto w-full ${maxW} bg-white shadow-xl border
                   min-h-screen sm:min-h-0 sm:rounded-2xl sm:my-4
                   max-h-none sm:max-h-[92vh] overflow-hidden flex flex-col`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Sticky header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:p-4 border-b bg-white sticky top-0 z-10 shrink-0">
          <h3 className="text-base sm:text-lg font-semibold truncate">{title}</h3>
          <button
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border hover:bg-gray-100 transition text-gray-600"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Scrollable content area */}
        <div className="p-3 sm:p-4 md:p-6 overflow-y-auto flex-1">
          {children}
        </div>
      </div>
    </div>
  );
}
