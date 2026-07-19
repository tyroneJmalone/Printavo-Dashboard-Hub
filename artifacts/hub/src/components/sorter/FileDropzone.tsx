import { useCallback, useRef, useState } from "react";
import { UploadCloud, File as FileIcon, X } from "lucide-react";

interface FileDropzoneProps {
  onFilesAccepted: (files: File[]) => void;
  onFileRemoved: (index: number) => void;
  files: File[];
  multiple?: boolean;
  accept?: Record<string, string[]>;
  label?: string;
}

export function FileDropzone({
  onFilesAccepted,
  onFileRemoved,
  files,
  multiple = true,
  accept = { "application/pdf": [".pdf"] },
  label = "Upload files",
}: FileDropzoneProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragActive(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const droppedFiles = Array.from(e.dataTransfer.files);
        const allowedExtensions = Object.values(accept).flat();
        const validFiles = droppedFiles.filter((f) => {
          if (allowedExtensions.length === 0) return true;
          return allowedExtensions.some((ext) =>
            f.name.toLowerCase().endsWith(ext.toLowerCase()),
          );
        });

        if (validFiles.length > 0) {
          onFilesAccepted(multiple ? validFiles : [validFiles[0]]);
        }
      }
    },
    [onFilesAccepted, multiple, accept],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        const selectedFiles = Array.from(e.target.files);
        onFilesAccepted(multiple ? selectedFiles : [selectedFiles[0]]);
        // Reset so the same file can be re-selected after removal
        e.target.value = "";
      }
    },
    [onFilesAccepted, multiple],
  );

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const acceptString = Object.values(accept).flat().join(",");

  return (
    <div className="w-full">
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        className={`border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center cursor-pointer transition-colors duration-200 text-center ${
          isDragActive
            ? "border-[#059669] bg-[#059669]/5"
            : "border-slate-700 hover:border-[#059669]/50 hover:bg-slate-800/50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple={multiple}
          accept={acceptString}
          onChange={handleChange}
          className="hidden"
          data-testid="input-file-dropzone"
        />
        <UploadCloud className="h-10 w-10 text-slate-500 mb-4" />
        <p className="text-sm font-medium text-slate-200">
          {isDragActive
            ? "Drop the files here ..."
            : `Drag and drop ${multiple ? "files" : "a file"} here, or click to select`}
        </p>
        <p className="text-xs text-slate-500 mt-1">{label}</p>
      </div>

      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.map((file, index) => (
            <div
              key={`${file.name}-${index}`}
              className="flex items-center justify-between p-3 bg-slate-800/60 rounded-md border border-slate-700"
            >
              <div className="flex items-center space-x-3 overflow-hidden">
                <FileIcon className="h-5 w-5 text-[#10b981] flex-shrink-0" />
                <span className="text-sm font-medium truncate text-slate-200">
                  {file.name}
                </span>
                <span className="text-xs text-slate-500 flex-shrink-0">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </div>
              <button
                className="h-8 w-8 flex items-center justify-center rounded text-slate-400 hover:text-red-400 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onFileRemoved(index);
                }}
                title="Remove file"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
