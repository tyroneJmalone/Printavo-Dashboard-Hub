import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, RotateCcw, AlertTriangle, X, ImageIcon } from "lucide-react";
import { type CatalogSearchHit, type CatalogMatchedColor } from "@workspace/api-client-react";

interface ProductPhotoViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hit: CatalogSearchHit;
  initialColorName?: string;
}

function ZoomPanImage({ src, alt, onReset }: { src: string, alt: string, onReset?: () => void }) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imgError, setImgError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    setImgError(false);
    onReset?.();
  }, [src, onReset]);

  const clampPan = (newX: number, newY: number, currentScale: number) => {
    if (!containerRef.current) return { x: newX, y: newY };
    const { clientWidth, clientHeight } = containerRef.current;
    // Bounding based on how much the image exceeds the container size at current scale
    const maxPanX = Math.max(0, (clientWidth * (currentScale - 1)) / 2);
    const maxPanY = Math.max(0, (clientHeight * (currentScale - 1)) / 2);
    return {
      x: Math.min(Math.max(newX, -maxPanX), maxPanX),
      y: Math.min(Math.max(newY, -maxPanY), maxPanY)
    };
  };

  const updatePan = (newX: number, newY: number, currentScale = scale) => {
    setPan(clampPan(newX, newY, currentScale));
  };

  const handleZoomIn = () => setScale(s => Math.min(s + 0.5, 4));
  const handleZoomOut = () => {
    setScale(s => {
      const newScale = Math.max(s - 0.5, 1);
      if (newScale === 1) {
        setPan({ x: 0, y: 0 });
      } else {
        setPan(p => clampPan(p.x, p.y, newScale));
      }
      return newScale;
    });
  };
  const handleReset = () => { setScale(1); setPan({ x: 0, y: 0 }); };

  if (imgError) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-100 text-slate-400 rounded-md gap-3 p-6 text-center">
        <AlertTriangle className="w-10 h-10 text-slate-300" />
        <p className="text-sm font-medium">Image not available</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full flex flex-col bg-slate-100 rounded-md overflow-hidden ring-1 ring-black/5">
      <div className="absolute top-2 right-2 z-10 flex gap-1 bg-white/90 backdrop-blur-sm p-1 rounded-md shadow-sm border border-slate-200/50">
        <Button aria-label="Zoom out" variant="ghost" size="icon" className="h-8 w-8 text-slate-600 hover:text-slate-900 hover:bg-slate-200/50" onClick={handleZoomOut} disabled={scale <= 1}>
          <ZoomOut className="w-4 h-4" />
        </Button>
        <Button aria-label="Reset zoom" variant="ghost" size="icon" className="h-8 w-8 text-slate-600 hover:text-slate-900 hover:bg-slate-200/50" onClick={handleReset} disabled={scale === 1 && pan.x === 0 && pan.y === 0}>
          <RotateCcw className="w-4 h-4" />
        </Button>
        <Button aria-label="Zoom in" variant="ghost" size="icon" className="h-8 w-8 text-slate-600 hover:text-slate-900 hover:bg-slate-200/50" onClick={handleZoomIn} disabled={scale >= 4}>
          <ZoomIn className="w-4 h-4" />
        </Button>
      </div>
      
      <div 
        className={`flex-1 overflow-hidden touch-none ${scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
        onPointerDown={(e) => {
          if (scale <= 1) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setIsDragging(true);
          setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
        }}
        onPointerMove={(e) => {
          if (!isDragging) return;
          updatePan(e.clientX - dragStart.x, e.clientY - dragStart.y, scale);
        }}
        onPointerUp={(e) => {
          setIsDragging(false);
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          setIsDragging(false);
        }}
        onKeyDown={(e) => {
          const step = 40;
          let handled = true;
          if (e.key === 'ArrowUp') updatePan(pan.x, pan.y + step, scale);
          else if (e.key === 'ArrowDown') updatePan(pan.x, pan.y - step, scale);
          else if (e.key === 'ArrowLeft') updatePan(pan.x + step, pan.y, scale);
          else if (e.key === 'ArrowRight') updatePan(pan.x - step, pan.y, scale);
          else if (e.key === '=' || e.key === '+') handleZoomIn();
          else if (e.key === '-') handleZoomOut();
          else if (e.key === '0') handleReset();
          else handled = false;

          if (handled) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        tabIndex={0}
      >
        <div className="w-full h-full flex items-center justify-center p-4">
          <img 
            src={src} 
            alt={alt}
            onError={() => setImgError(true)}
            draggable={false}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transition: isDragging ? 'none' : 'transform 0.15s ease-out'
            }}
            className="max-w-full max-h-full object-contain pointer-events-none origin-center"
          />
        </div>
      </div>
    </div>
  );
}

export function ProductPhotoViewer({ open, onOpenChange, hit, initialColorName }: ProductPhotoViewerProps) {
  const [selectedColorName, setSelectedColorName] = useState<string | null>(null);
  const [showFullDesc, setShowFullDesc] = useState(false);

  // Sync initial color when opened, use reference to avoid resetting on background data refreshes
  const openRef = useRef(false);
  useEffect(() => {
    if (open && !openRef.current) {
      if (initialColorName && hit.colors?.some(c => c.colorName === initialColorName)) {
        setSelectedColorName(initialColorName);
      } else {
        setSelectedColorName(null);
      }
      setShowFullDesc(false);
    }
    openRef.current = open;
  }, [open, initialColorName, hit.colors]);

  const colors = hit.colors || [];
  
  const selectedColor = selectedColorName 
    ? colors.find(c => c.colorName === selectedColorName)
    : null;

  const isColorSelected = selectedColorName !== null;
  const currentImage = isColorSelected ? selectedColor?.productImage : hit.styleImage;
  const description = hit.description?.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[90vh] md:h-[80vh] flex flex-col p-0 gap-0 bg-[#0f172a] border-slate-700 overflow-hidden" hideCloseButton>
        {/* Header */}
        <div className="flex items-start justify-between p-4 md:p-6 border-b border-slate-800 shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <DialogTitle className="text-xl font-bold text-white capitalize">{hit.vendor}</DialogTitle>
              <div className="text-sm font-bold text-[#10b981] bg-[#10b981]/10 px-2 py-0.5 rounded border border-[#10b981]/20">
                {hit.styleName}
              </div>
              {hit.brand && <div className="text-xs font-medium text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">{hit.brand}</div>}
            </div>
            <DialogDescription className="text-slate-300 font-medium">
              {hit.title}
            </DialogDescription>
          </div>
          <Button aria-label="Close photo viewer" variant="ghost" size="icon" onClick={() => onOpenChange(false)} className="text-slate-400 hover:text-white hover:bg-slate-800 -mr-2 -mt-2">
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
          {/* Main Photo Area */}
          <div className="flex-1 p-4 md:p-6 min-h-0 flex flex-col items-center justify-center bg-slate-900/50">
            {currentImage ? (
              <ZoomPanImage 
                key={selectedColorName ?? "__default"}
                src={currentImage} 
                alt={`${hit.title} ${selectedColor?.colorName || ''}`} 
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center bg-slate-100 rounded-md text-slate-400 gap-3 border border-slate-200/50">
                <AlertTriangle className="w-10 h-10 text-slate-300" />
                <p className="text-sm font-medium">No product image available</p>
              </div>
            )}
            
            {selectedColor && (
              <div className="mt-4 text-center">
                <span className="text-sm font-medium text-white bg-slate-800 px-3 py-1 rounded-full border border-slate-700">
                  {selectedColor.colorName}
                </span>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="w-full md:w-80 flex flex-col bg-slate-900 border-l border-slate-800 shrink-0 h-[40vh] md:h-auto overflow-y-auto custom-scrollbar">
            {/* Description Section */}
            <div className="p-4 md:p-6 border-b border-slate-800 shrink-0">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">Description</h3>
              {description ? (
                <div>
                  <p className={`text-sm text-slate-300 whitespace-pre-wrap ${!showFullDesc ? 'line-clamp-4' : ''}`}>
                    {description}
                  </p>
                  {description && (
                    <button 
                      onClick={() => setShowFullDesc(!showFullDesc)}
                      className="text-xs font-medium text-[#10b981] hover:text-[#059669] mt-2 transition-colors"
                    >
                      {showFullDesc ? "Read less" : "Show more"}
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500 italic">Description unavailable</p>
              )}
            </div>

            {/* Colors Section */}
            <div className="p-4 md:p-6 shrink-0">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-3 shrink-0">
                Photos ({colors.length + 1})
              </h3>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedColorName(null)}
                  aria-pressed={selectedColorName === null}
                  className={`flex items-center gap-2 p-1.5 pr-3 rounded border text-left transition-colors min-w-[120px] max-w-full ${
                    selectedColorName === null 
                      ? "bg-slate-800 border-[#10b981] ring-1 ring-[#10b981] shadow-sm" 
                      : "bg-slate-950 border-slate-800 hover:border-slate-600 hover:bg-slate-900"
                  }`}
                >
                  <div className="w-6 h-6 rounded-sm bg-slate-800 shadow-sm flex-shrink-0 flex items-center justify-center text-slate-500 border border-slate-700">
                     <ImageIcon className="w-3.5 h-3.5" />
                  </div>
                  <span className={`text-xs font-medium truncate ${selectedColorName === null ? "text-white" : "text-slate-300"}`}>
                    Default Photo
                  </span>
                </button>
                
                {colors.map(color => {
                  const isActive = selectedColorName === color.colorName;
                  return (
                    <button
                      key={color.colorName}
                      onClick={() => setSelectedColorName(color.colorName)}
                      aria-pressed={isActive}
                      className={`flex items-center gap-2 p-1.5 pr-3 rounded border text-left transition-colors min-w-[120px] max-w-full ${
                        isActive 
                          ? "bg-slate-800 border-[#10b981] ring-1 ring-[#10b981] shadow-sm" 
                          : "bg-slate-950 border-slate-800 hover:border-slate-600 hover:bg-slate-900"
                      }`}
                      title={color.colorName}
                    >
                      {color.swatchImage ? (
                        <img src={color.swatchImage} className="w-6 h-6 rounded-sm shadow-sm flex-shrink-0 bg-slate-200" alt="" />
                      ) : (
                        <div className="w-6 h-6 rounded-sm bg-slate-700 shadow-sm flex-shrink-0" />
                      )}
                      <span className={`text-xs font-medium truncate ${isActive ? "text-white" : "text-slate-300"}`}>
                        {color.colorName}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
