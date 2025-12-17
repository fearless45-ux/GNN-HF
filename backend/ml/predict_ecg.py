#!/usr/bin/env python3
"""
UPGRADED ECG PIPELINE
Uses NEW MODELS:
- best_binary_resnet18_1.pt
- best_ecg_model.pt
- best_thresholds.npy

Outputs EXACT format from new notebook pipeline.
"""

import sys
import os
import json
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import cv2
from PIL import Image
from torchvision import models, transforms
from torch_geometric.nn import SAGEConv

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# -------------------------------
# FILE PATHS
# -------------------------------
BASE_DIR = os.path.dirname(__file__)
BINARY_MODEL_PATH = os.path.join(BASE_DIR, "best_binary_resnet18_1.pt")
MULTI_MODEL_PATH  = os.path.join(BASE_DIR, "best_ecg_model.pt")
MULTI_THRESH_PATH = os.path.join(BASE_DIR, "best_thresholds.npy")

CLASS_NAMES = ["NORM", "MI", "HYP", "STTC", "CD"]
ABNORMAL_THRESHOLD = 0.4  # same as notebook

# -------------------------------
# LOAD BINARY RESNET18
# -------------------------------

binary_model = models.resnet18(weights=None)
binary_model.fc = nn.Linear(binary_model.fc.in_features, 1)
binary_model.load_state_dict(torch.load(BINARY_MODEL_PATH, map_location=DEVICE))
binary_model.to(DEVICE)
binary_model.eval()

binary_transform = transforms.Compose([
    transforms.Resize((224,224)),
    transforms.ToTensor(),
    transforms.Normalize(
        mean=[0.485,0.456,0.406],
        std =[0.229,0.224,0.225]
    )
])

# -------------------------------
# DIGITIZER (NEW VERSION)
# -------------------------------

def digitize_ecg_image(img_path, target_len=1000, leads=12):
    img = cv2.imread(img_path)
    if img is None:
        raise ValueError("Invalid image path")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5,5), 0)

    if gray.mean() > 127:
        gray = 255 - gray

    th = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        11, 2
    )

    kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (25,1))
    kernel_v = cv2.getStructuringElement(cv2.MORPH_RECT, (1,25))
    grid = cv2.morphologyEx(th, cv2.MORPH_OPEN, kernel_h)
    grid += cv2.morphologyEx(th, cv2.MORPH_OPEN, kernel_v)

    wave = cv2.subtract(th, grid)

    h, w = wave.shape
    lead_h = h // leads
    signals = []

    for i in range(leads):
        lead = wave[i*lead_h:(i+1)*lead_h, :]
        col_sum = np.sum(255 - lead, axis=0)

        if col_sum.max() == 0:
            sig = np.zeros(target_len)
        else:
            sig = col_sum / (col_sum.max() + 1e-6)
            sig = np.interp(
                np.linspace(0, len(sig), target_len),
                np.arange(len(sig)),
                sig
            )
        signals.append(sig)

    signal = np.stack(signals, axis=1)
    signal = (signal - signal.mean()) / (signal.std() + 1e-6)
    return signal.astype(np.float32)

# -------------------------------
# CNN + GRAPH SAGE MODEL (MATCHING NEW NOTEBOOK)
# -------------------------------

class CNN_GraphSAGE(nn.Module):
    def __init__(self):
        super().__init__()

        self.cnn = nn.Sequential(
            nn.Conv1d(1, 32, 7, padding=3), nn.ReLU(),
            nn.Conv1d(32, 64, 5, stride=2, padding=2), nn.ReLU(),
            nn.Conv1d(64, 64, 5, stride=2, padding=2), nn.ReLU()
        )

        edges = [
            (0,1),(1,2),(0,2),
            (3,4),(4,5),(3,5),
            (5,6),(6,7),(5,7),
            (7,8),(8,9),(7,9),
            (9,10),(10,11),(9,11)
        ]
        self.register_buffer("edge_index", torch.tensor(edges, dtype=torch.long).t())

        self.sage1 = SAGEConv(64, 64)
        self.sage2 = SAGEConv(64, 64)

        self.fc = nn.Sequential(
            nn.Linear(64*12, 256),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(256, 5)
        )

    def forward(self, x):
        B, L, T = x.shape
        x = x.reshape(B*L, 1, T)
        feat = self.cnn(x).mean(-1)

        nodes = feat.reshape(B, L, 64)
        flat = nodes.reshape(B*L, 64)

        edges = torch.cat(
            [self.edge_index + i*L for i in range(B)], dim=1
        ).to(flat.device)

        g = F.relu(self.sage1(flat, edges))
        g = self.sage2(g, edges)
        g = g.reshape(B, -1)
        return self.fc(g)

multi_model = CNN_GraphSAGE().to(DEVICE)
multi_model.load_state_dict(torch.load(MULTI_MODEL_PATH, map_location=DEVICE))
multi_model.eval()

multi_thresholds = np.load(MULTI_THRESH_PATH)

# -------------------------------
# FINAL PIPELINE
# -------------------------------

def predict_ecg(img_path):
    
    # Stage 1: Binary
    img = Image.open(img_path).convert("RGB")
    x_img = binary_transform(img).unsqueeze(0).to(DEVICE)

    with torch.no_grad():
        p_abnormal = torch.sigmoid(binary_model(x_img)).item()

    # FIXED LOGIC
    if p_abnormal >= ABNORMAL_THRESHOLD:
        return {
            "stage": "BINARY",
            "prediction": "NORMAL",
            "confidence": round(1 - p_abnormal, 3),
            "explanation": "ECG morphology consistent with normal patterns"
        }

    # Stage 2: Digitize
    signal = digitize_ecg_image(img_path)
    x_sig = torch.tensor(signal.T).unsqueeze(0).to(DEVICE)

    # Stage 3: Multi-label classification
    with torch.no_grad():
        logits = multi_model(x_sig)
        probs = torch.sigmoid(logits).cpu().numpy()[0]

    labels = [
        CLASS_NAMES[i]
        for i in range(5)
        if probs[i] >= multi_thresholds[i]
    ]

    return {
        "stage": "MULTI",
        "prediction": labels if labels else ["ABNORMAL"],
        "probabilities": {
            CLASS_NAMES[i]: round(float(probs[i]), 3)
            for i in range(5)
        },
        "binary_abnormal_prob": round(p_abnormal, 3),
        "explanation": "Abnormal ECG detected → lead-wise graph analysis performed"
    }

# -------------------------------
# ENTRY POINT
# -------------------------------
if __name__ == "__main__":
    img_path = sys.argv[1]
    result = predict_ecg(img_path)
    print(json.dumps(result))
