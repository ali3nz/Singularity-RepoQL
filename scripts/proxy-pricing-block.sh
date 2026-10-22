# client-facing model catalog: the proxy serves GET /<lane>/<space>/v1/models
# from its own local pricing table (NOT a passthrough), so without a
# creditPricing.models section the catalog is EMPTY and the lane gate can
# never discover a model. PROXY_PRICING_MODELS="a,b,c" registers ids with
# zero prices (the catalog is discovery, not billing).
CREDIT_PRICING_BLOCK=""
if [[ -n "${PROXY_PRICING_MODELS:-}" ]]; then
  MODELS_BLOCK=""
  IFS=',' read -ra PRICING_IDS <<< "$PROXY_PRICING_MODELS"
  for M in "${PRICING_IDS[@]}"; do
    M="$(echo "$M" | xargs)"
    [[ -z "$M" ]] && continue
    MODELS_BLOCK+="    - name: \"$M\""$'\n'"      modelName: \"$M\""$'\n'"      input: 0"$'\n'"      output: 0"$'\n'
  done
  if [[ -n "$MODELS_BLOCK" ]]; then
    CREDIT_PRICING_BLOCK="# 由 PROXY_PRICING_MODELS 生成 —— 本地模型目录（/models 由它服务，而非透传）。"$'\n'"creditPricing:"$'\n'"  models:"$'\n'"$MODELS_BLOCK"
  fi
fi
