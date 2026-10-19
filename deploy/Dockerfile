FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --system --uid 10001 stage && mkdir /data && chown stage /data
COPY server.py archive_manager.py index.html app.js archive-admin.html archive-admin.js \
     performance-motion.js replay-timing.js stage-direction.js fingertip-contact.js \
     concert_stage.glb rig_calibration.json ./
ENV PORT=8765 HOST=0.0.0.0 ARCHIVE_DIR=/data/archives
USER stage
EXPOSE 8765
CMD ["python", "server.py"]
