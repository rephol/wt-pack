# WP-78: a fresh-install smoke test on Linux, following the README quick start in a clean node:22 image.
#   docker build -f test/docker/Dockerfile --build-arg HC_INSTALL='<command that installs herdr-app, which installs hc>' -t wt-pack-install .   (from the repo root; copies the working tree)
#   docker run --rm wt-pack-install                                 (starts the hc core, doctor + dashboard health, then exits)
# The copy stands in for `git clone` (no GitHub access needed); gh stays logged out, so doctor reports one failure.
FROM node:22
RUN apt-get update -qq && apt-get install -y -qq jq gh >/dev/null && rm -rf /var/lib/apt/lists/*
# HC_INSTALL is the command that installs herdr-app (which installs hc, herdr-core) on a Linux box; it must leave `hc` in /root/.local/bin or on PATH.
ARG HC_INSTALL=""
RUN if [ -n "$HC_INSTALL" ]; then sh -c "$HC_INSTALL"; else echo 'no HC_INSTALL given: the image has no hc and doctor will say so'; fi
RUN npm i -g @anthropic-ai/claude-code >/dev/null 2>&1
ENV PATH=/root/.local/bin:$PATH
COPY . /root/wt-pack
WORKDIR /root/wt-pack
RUN git init -q -b main 2>/dev/null; git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm snapshot || true
RUN ./setup --no-secrets || true
CMD ["sh", "test/docker/smoke.sh"]
