# syntax=docker/dockerfile:1.7
#
# Toolchain image for the infra/ data pipeline at planet scale.
#
# Everything infra/README.md tells you to `brew install` on a laptop, pinned and
# reproducible, plus an orchestrator (build-global.sh) that runs the whole pipeline
# against Geofabrik's continent extracts instead of the regions.json-derived default.
#
# Versions are pinned deliberately (same posture as C13 — never track "latest"):
# tippecanoe and pmtiles are the exact versions the 2026-08-21/22 laptop runs used, so a
# containerised rebuild is comparable to the numbers recorded in infra/README.md.
#
#   docker build -f docker/Dockerfile -t ratmap-infra:latest .      # context = infra/
#
# Build args let you move a version without editing this file:
#   --build-arg TIPPECANOE_VERSION=2.80.0
#
# Multi-arch: builds on linux/amd64 and linux/arm64 (Apple Silicon runs arm64 natively —
# do NOT let Docker fall back to emulated amd64 here, osmium and tippecanoe under QEMU are
# several times slower and this pipeline already runs for days).

ARG DEBIAN_TAG=trixie-slim

########################################################################
# Stage 1 — tippecanoe from source
#
# Debian trixie packages tippecanoe 2.53.0; the recorded laptop runs used 2.79.0, and
# tippecanoe's feature-dropping behaviour is version-sensitive enough that matching it
# matters more than saving a compile.
########################################################################
FROM debian:${DEBIAN_TAG} AS tippecanoe-build

ARG TIPPECANOE_VERSION=2.79.0

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        libsqlite3-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${TIPPECANOE_VERSION}" \
        https://github.com/felt/tippecanoe.git /src/tippecanoe \
    && make -C /src/tippecanoe -j"$(nproc)" \
    && make -C /src/tippecanoe install PREFIX=/opt/tippecanoe MANDIR=/opt/tippecanoe/share/man \
    && /opt/tippecanoe/bin/tippecanoe --version

########################################################################
# Stage 2 — pmtiles release binary, checksum-verified
#
# The SHA256s below were computed from the published release tarballs. If you bump
# PMTILES_VERSION you must bump these too — the build fails closed rather than silently
# installing an unverified binary.
########################################################################
FROM debian:${DEBIAN_TAG} AS pmtiles-fetch

ARG PMTILES_VERSION=1.31.2
ARG PMTILES_SHA256_AMD64=3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f
ARG PMTILES_SHA256_ARM64=f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) asset="Linux_x86_64"; sha="${PMTILES_SHA256_AMD64}" ;; \
      arm64) asset="Linux_arm64";  sha="${PMTILES_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/pmtiles.tar.gz \
      "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_${asset}.tar.gz"; \
    echo "${sha}  /tmp/pmtiles.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/pmtiles.tar.gz -C /usr/local/bin pmtiles; \
    chmod 0755 /usr/local/bin/pmtiles; \
    /usr/local/bin/pmtiles version

########################################################################
# Stage 3 — runtime
########################################################################
FROM debian:${DEBIAN_TAG}

# gdal-bin      -> gdalbuildvrt / gdal_translate / gdal_contour / ogr2ogr (build-contours.sh)
# osmium-tool   -> tags-filter / merge / export      (build-peaks.sh, build-places.sh)
# awscli        -> manifest.json upload              (upload.sh)
# sqlite3       -> inspecting places.sqlite by hand; the build itself uses python3's module
# libsqlite3-0/zlib1g/libstdc++6 -> explicit, because tippecanoe is copied in rather than
#                  apt-installed and so pulls no dependencies of its own
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        curl \
        gdal-bin \
        libsqlite3-0 \
        libstdc++6 \
        osmium-tool \
        python3 \
        sqlite3 \
        awscli \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tippecanoe-build /opt/tippecanoe/bin/ /usr/local/bin/
COPY --from=pmtiles-fetch    /usr/local/bin/pmtiles /usr/local/bin/pmtiles

# Fail the image build, not a three-day pipeline run, if the interpreter that has to
# create places.sqlite can't create an FTS5 table (C9 — the whole search index is FTS5).
# Debian's libsqlite3 enables FTS5, but that is a distro build flag, not a guarantee.
RUN python3 - <<'PY'
import sqlite3
db = sqlite3.connect(":memory:")
db.execute("CREATE VIRTUAL TABLE t USING fts5(name, tokenize=\"unicode61 remove_diacritics 2\")")
db.execute("INSERT INTO t (name) VALUES ('Ben Nevis')")
assert db.execute("SELECT count(*) FROM t WHERE t MATCH 'nevis'").fetchone()[0] == 1
print("sqlite3 FTS5 + unicode61 remove_diacritics 2: OK", sqlite3.sqlite_version)
PY

# /work holds everything big and resumable: the Geofabrik cache, scratch space for
# mktemp, and stage logs. It must be a real volume on a disk with room — see
# docker/README.md. TMPDIR matters more than it looks: every build script does
# `mktemp -d`, and left at /tmp a planet run fills the container's writable layer and
# dies partway through with a confusing ENOSPC.
#
# OSM_CACHE_DIR points lib.sh's cached_osm_extract at the volume too. Without it the
# scripts would cache continent extracts inside the image at infra/.cache/osm — a second
# 85 GB copy, on the container's writable layer, thrown away when the container exits.
ENV TMPDIR=/work/tmp \
    HOME=/work/home \
    RATMAP_WORK=/work \
    RATMAP_CACHE=/work/cache \
    OSM_CACHE_DIR=/work/cache/osm \
    PYTHONUNBUFFERED=1 \
    LC_ALL=C.UTF-8 \
    LANG=C.UTF-8

# GDAL reads Copernicus COGs over /vsicurl for hours at a time; the defaults give up too
# easily on a flaky link and lose a whole region's contour trace.
ENV GDAL_HTTP_TIMEOUT=120 \
    GDAL_HTTP_MAX_RETRY=5 \
    GDAL_HTTP_RETRY_DELAY=5 \
    VSI_CACHE=TRUE \
    VSI_CACHE_SIZE=536870912 \
    GDAL_CACHEMAX=2048

# aws-cli v2 sends CRC32 request checksums by default. R2 accepts them today, but this
# pipeline's only aws call is a 4 KB manifest.json PUT and a checksum mismatch there
# fails the *last* step of a multi-day run. Not worth the risk.
ENV AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
    AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

# The pipeline itself, baked in so the image runs standalone. Bind-mount your working
# copy over /opt/ratmap/infra/scripts to iterate without rebuilding.
# .dockerignore keeps dist/ and .env out — credentials never belong in an image layer.
WORKDIR /opt/ratmap/infra
COPY scripts/ /opt/ratmap/infra/scripts/
COPY regions.json /opt/ratmap/infra/regions.json

# The planet driver lives outside the infra tree on purpose: compose bind-mounts a
# working copy over /opt/ratmap/infra/scripts, and anything installed *into* scripts/
# would vanish behind that mount.
COPY docker/build-global.sh /usr/local/bin/ratmap-global
COPY docker/entrypoint.sh /usr/local/bin/ratmap
RUN chmod +x /usr/local/bin/ratmap /usr/local/bin/ratmap-global \
    && chmod +x /opt/ratmap/infra/scripts/*.sh /opt/ratmap/infra/scripts/*.py

ENTRYPOINT ["/usr/local/bin/ratmap"]
CMD ["help"]
