# Build from the repository root with locked dependencies and compiled TypeScript exports.
FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS build
WORKDIR /opt/rae
COPY . .
RUN ["npm", "ci", "--ignore-scripts"]
RUN ["npm", "run", "build", "--workspace", "@rae/contracts"]
RUN ["npm", "run", "build", "--workspace", "@rae/dev-tools-shared"]
RUN ["npm", "run", "build", "--workspace", "packages/dev-tools/multi-model-review"]
RUN ["npm", "prune", "--omit=dev", "--ignore-scripts"]

FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c
WORKDIR /opt/rae/packages/dev-tools/multi-model-review
COPY --from=build /opt/rae/node_modules/ /opt/rae/node_modules/
COPY --from=build /opt/rae/packages/dev-tools/shared/dist/ /opt/rae/packages/dev-tools/shared/dist/
COPY --from=build /opt/rae/packages/dev-tools/shared/package.json /opt/rae/packages/dev-tools/shared/package.json
COPY --from=build /opt/rae/packages/dev-tools/multi-model-review/dist/ dist/
COPY --from=build /opt/rae/packages/dev-tools/multi-model-review/package.json ./
COPY --from=build /opt/rae/packages/contracts/ /opt/rae/packages/contracts/
# The tool lives in /opt/rae so the read-only repository mount at /workspace cannot hide it.
ENV RAE_TOOL_ROOT=/opt/rae
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "dist/index.js", "--healthcheck"]
ENTRYPOINT ["node", "dist/index.js"]
