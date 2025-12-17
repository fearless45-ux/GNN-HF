import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BackToHome } from "@/components/BackToHome";

import { API_ENDPOINTS } from "@/config/api";
import { getAuthHeaders, getAuthHeadersForFormData } from "@/config/apiUtils";

import {
  Upload,
  Save,
  Image as ImageIcon,
  X,
  Brain,
  Loader2,
  User,
  AlertTriangle
} from "lucide-react";

type AnalysisState = "idle" | "analyzing" | "complete" | "error";

interface AnalysisResult {
  predictedClass: string;
  confidence: number;
  riskLevel: string;
  riskScore: number;
  probabilities: Record<string, number>;
  imagePath?: string;
}

interface PatientData {
  patientName: string;
  age: string;
  gender: string;
  patientId: string;
  contactNumber: string;
  patientEmail: string;
  symptoms: string;
  medicalHistory: string;
}

export default function UploadPage() {
  const email = localStorage.getItem("email") || "";

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [state, setState] = useState<AnalysisState>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(
    null
  );
  const [dragActive, setDragActive] = useState(false);

  const [patientData, setPatientData] = useState<PatientData>({
    patientName: "",
    age: "",
    gender: "",
    patientId: "",
    contactNumber: "",
    patientEmail: "",
    symptoms: "",
    medicalHistory: ""
  });

  // ============================= DRAG / DROP HANDLING =============================
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, []);

  const handleFile = (selectedFile: File) => {
    if (!selectedFile.type.startsWith("image/")) return;

    setFile(selectedFile);

    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(selectedFile);

    setState("idle");
    setResult(null);
    setError(null);
  };

  const removeImage = () => {
    setFile(null);
    setPreview(null);
    setState("idle");
    setResult(null);
    setError(null);
  };

  // =========================== RUN ANALYSIS / PREDICT ===========================
  const runAnalysis = async () => {
    if (!file) return;

    setState("analyzing");
    setProgress(20);
    setError(null);

    const formData = new FormData();
    formData.append("ecgImage", file);

    try {
      const res = await fetch(API_ENDPOINTS.PREDICT, {
        method: "POST",
        headers: getAuthHeadersForFormData(),
        body: formData
      });

      const data = await res.json();
      console.log("🟣 Prediction Response:", data);

      if (data.status !== "success") {
        setError({
          title: "Prediction Failed",
          message: data.message || "Model could not process this ECG."
        });
        setState("error");
        return;
      }

      const r = data.result;
      let parsed: AnalysisResult | null = null;

      // ------------ BINARY NORMAL CASE ------------
      if (r.stage === "BINARY") {
        const conf = (r.confidence ?? r.binary_normal_prob ?? 1) * 100;

        parsed = {
          predictedClass: "NORMAL",
          confidence: conf,
          riskScore: Math.round(100 - conf),
          riskLevel: "low",
          probabilities: r.probabilities || {},
          imagePath: r.imagePath
        };
      }

      // ------------ MULTI-LABEL ABNORMAL CASE ------------
      else if (r.stage === "MULTI") {
        const predicted = Array.isArray(r.prediction)
          ? r.prediction[0]
          : r.prediction;

        const conf = (r.probabilities?.[predicted] ?? 0) * 100;

        parsed = {
          predictedClass: predicted,
          confidence: conf,
          riskScore: Math.round(conf),
          riskLevel:
            predicted === "MI" || predicted === "STTC"
              ? "high"
              : predicted === "HYP" || predicted === "CD"
              ? "moderate"
              : "low",
          probabilities: r.probabilities || {},
          imagePath: r.imagePath
        };
      }

      if (!parsed) {
        setError({
          title: "Unexpected Output",
          message: "Model returned unsupported response structure."
        });
        setState("error");
        return;
      }

      setResult(parsed);
      setProgress(100);
      setState("complete");
    } catch (err) {
      console.error("Prediction Error:", err);
      setError({
        title: "Server Error",
        message: "Could not connect to backend."
      });
      setState("error");
    }
  };

  // =========================== SAVE REPORT ===========================
  const handleSave = async () => {
    if (!result) return alert("Analyze ECG before saving!");
    if (!email) return alert("User not logged in!");

    if (
      !patientData.patientName ||
      !patientData.age ||
      !patientData.gender ||
      !patientData.patientId ||
      !patientData.contactNumber ||
      !patientData.patientEmail ||
      !patientData.symptoms ||
      !patientData.medicalHistory
    ) {
      return alert("Please fill all patient details before saving!");
    }

    const body = {
      email,
      predicted_class: result.predictedClass,
      confidence: result.confidence,
      risk_level: result.riskLevel,
      risk_score: result.riskScore,
      probabilities: result.probabilities,
      imagePath: result.imagePath,
      patientData
    };

    const res = await fetch(API_ENDPOINTS.SAVE_REPORT, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    console.log("💾 Save Response:", data);

    if (data.status === "success") {
      alert("Report saved successfully!");
      removeImage();
      setPatientData({
        patientName: "",
        age: "",
        gender: "",
        patientId: "",
        contactNumber: "",
        patientEmail: "",
        symptoms: "",
        medicalHistory: ""
      });
    } else {
      alert("Save failed: " + data.message);
    }
  };

  // =========================== RISK COLOR ===========================
  const getRiskColor = (risk: string) => {
    switch (risk) {
      case "high":
        return "text-red-600";
      case "moderate":
        return "text-yellow-600";
      default:
        return "text-green-600";
    }
  };

  // =========================== UI START ===========================
  return (
    <div className="space-y-8">
      <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold">Upload ECG for Analysis</h1>
            <p className="text-muted-foreground mt-1">
              Upload ECG image and provide patient details
            </p>
          </div>
          <BackToHome />
        </div>
      </motion.div>

      {/* ---------------- PATIENT DETAILS ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="w-5 h-5 text-primary" /> Patient Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              placeholder="Patient Name"
              value={patientData.patientName}
              onChange={(e) =>
                setPatientData({ ...patientData, patientName: e.target.value })
              }
            />
            <Input
              placeholder="Age"
              type="number"
              value={patientData.age}
              onChange={(e) =>
                setPatientData({ ...patientData, age: e.target.value })
              }
            />
            <Input
              placeholder="Gender"
              value={patientData.gender}
              onChange={(e) =>
                setPatientData({ ...patientData, gender: e.target.value })
              }
            />
            <Input
              placeholder="Patient ID"
              value={patientData.patientId}
              onChange={(e) =>
                setPatientData({ ...patientData, patientId: e.target.value })
              }
            />
            <Input
              placeholder="Contact Number"
              value={patientData.contactNumber}
              onChange={(e) =>
                setPatientData({
                  ...patientData,
                  contactNumber: e.target.value
                })
              }
            />
            <Input
              placeholder="Email"
              value={patientData.patientEmail}
              onChange={(e) =>
                setPatientData({
                  ...patientData,
                  patientEmail: e.target.value
                })
              }
            />
          </div>

          <Textarea
            placeholder="Symptoms"
            value={patientData.symptoms}
            onChange={(e) =>
              setPatientData({ ...patientData, symptoms: e.target.value })
            }
          />

          <Textarea
            placeholder="Medical History"
            value={patientData.medicalHistory}
            onChange={(e) =>
              setPatientData({ ...patientData, medicalHistory: e.target.value })
            }
          />
        </CardContent>
      </Card>

      {/* ---------------- ECG UPLOAD + ANALYSIS ---------------- */}
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-primary" /> ECG Image
          </CardTitle>
        </CardHeader>

        <CardContent>
          {!preview ? (
            <div
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer ${
                dragActive ? "border-primary bg-primary/5" : "border-border"
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => document.getElementById("ecg-input")?.click()}
            >
              <input
                id="ecg-input"
                type="file"
                accept="image/*"
                onChange={(e) =>
                  e.target.files && handleFile(e.target.files[0])
                }
                className="hidden"
              />
              <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-2" />
              <p>Drop ECG image or click to upload</p>
            </div>
          ) : (
            <>
              <div className="relative border rounded-xl overflow-hidden">
                <img src={preview} className="w-full h-48 object-contain" />
                <button
                  onClick={removeImage}
                  className="absolute top-2 right-2 bg-white/70 p-2 rounded-full"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {state === "analyzing" && (
                <div className="mt-4">
                  <Loader2 className="animate-spin text-primary w-5 h-5 mb-3" />
                  <Progress value={progress} />
                </div>
              )}

              {state === "error" && error && (
                <Alert variant="destructive" className="mt-4">
                  <AlertTriangle className="w-4 h-4" />
                  <AlertTitle>{error.title}</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                  <Button
                    className="w-full mt-4"
                    variant="outline"
                    onClick={() => {
                      setError(null);
                      setState("idle");
                    }}
                  >
                    Try Again
                  </Button>
                </Alert>
              )}

              {state === "idle" && (
                <Button className="w-full mt-4" onClick={runAnalysis}>
                  <Brain className="w-5 h-5 mr-2" />
                  Analyze ECG
                </Button>
              )}

              {state === "complete" && result && (
                <div className="mt-4 p-4 bg-muted/20 rounded-xl">
                  <div className="flex justify-between mb-3">
                    <p className="text-sm text-muted-foreground">Prediction Summary</p>
                    <Badge>{result.predictedClass}</Badge>
                  </div>

                  <div className="grid grid-cols-3 text-center">
                    <div>
                      <p className={`text-xl font-bold ${getRiskColor(result.riskLevel)}`}>
                        {result.riskScore}
                      </p>
                      <p className="text-xs">Risk Score</p>
                    </div>

                    <div>
                      <p className="text-xl font-bold">
                        {result.confidence.toFixed(1)}%
                      </p>
                      <p className="text-xs">Confidence</p>
                    </div>

                    <div>
                      <p className="font-medium">{result.predictedClass}</p>
                      <p className="text-xs">Prediction</p>
                    </div>
                  </div>

                  {Object.keys(result.probabilities).length > 0 && (
                    <div className="mt-5 text-sm">
                      <p className="font-medium mb-2">Class Probabilities</p>
                      {Object.entries(result.probabilities).map(([label, value]) => (
                        <div key={label}>
                          <div className="flex justify-between text-xs">
                            <span>{label}</span>
                            <span>{(value * 100).toFixed(1)}%</span>
                          </div>
                          <Progress value={value * 100} className="h-2 mb-2" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {state === "complete" && result && (
        <Button
          className="w-full max-w-2xl mx-auto h-12 text-lg"
          onClick={handleSave}
        >
          <Save className="w-5 h-5 mr-2" />
          Save ECG Analysis Report
        </Button>
      )}
    </div>
  );
}
