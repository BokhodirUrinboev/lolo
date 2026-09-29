"""
QLoRA fine-tune of qwen2.5-coder:7b on Agent Lolo trajectories (plan item 14).

  node dist/eval.js export --out dataset.jsonl --exclude <held-out task ids> eval/results/*/
  pip install torch --index-url https://download.pytorch.org/whl/cu128   # CUDA GPU, ~9 GB VRAM for 7B QLoRA
  pip install unsloth trl datasets
  python scripts/finetune/train_lora.py dataset.jsonl out/lolo-lora [--epochs=1]
  # → out/lolo-lora/merged (16-bit safetensors). Current Ollama imports safetensors only for
  # MLX architectures (not Qwen2), so convert with llama.cpp: convert_hf_to_gguf.py is in its
  # source, llama-quantize in any release zip (no compiler needed).
  python llama.cpp/convert_hf_to_gguf.py out/lolo-lora/merged --outtype bf16 --outfile out/lolo-lora/lolo-bf16.gguf
  llama-quantize out/lolo-lora/lolo-bf16.gguf out/lolo-lora/lolo-coder.gguf Q4_K_M
  ollama create lolo-coder -f scripts/finetune/Modelfile
  node dist/eval.js run --runs 2 --model lolo-coder --filter <held-out ids>   # compare with the base model

Only the assistant replies (tool calls, plans) are trained; prompts are masked.
Samples come from successful runs only, and invalid/stuck steps are dropped by the export.
Hold some eval tasks out of the dataset (--exclude), or the eval measures memorization.
Stop Ollama's loaded models first (`ollama stop <model>`): training needs the GPU memory.
Measured on a 12 GB RTX GPU: ~5.4 GB after loading, 1 epoch over 2k samples ≈ 3-4 h.
"""
import os
import sys

# The fused loss sizes its chunks from the GPU's free memory, which doesn't count what PyTorch
# holds cached, so after a few steps it sees ~0 GB free and stops. A fixed budget avoids that.
os.environ.setdefault("UNSLOTH_CE_LOSS_TARGET_GB", "1")

# unsloth first: it patches transformers/trl/peft (and their memory use) on import.
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only

from datasets import load_dataset
from trl import SFTConfig, SFTTrainer


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    data_file, out_dir = args[0], args[1]
    epochs = float(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--epochs=")), "2"))
    # Samples from the eval are ~2k tokens (the longest ~4k); longer ones keep their end.
    MAX_LEN = int(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--max-len=")), "4096"))

    model, tokenizer = FastLanguageModel.from_pretrained("unsloth/Qwen2.5-Coder-7B-Instruct", max_seq_length=MAX_LEN, load_in_4bit=True)
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=32,
        lora_dropout=0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth",
    )

    # Tokenized here, with a fixed fingerprint: `datasets` otherwise pickles the map function to
    # fingerprint it, and the patched tokenizer it closes over can't be pickled. With input_ids
    # present, TRL skips its own tokenization (which passes the tokenizer the same way).
    ds = load_dataset("json", data_files=data_file, split="train")
    ds = ds.map(
        lambda r: {"input_ids": tokenizer(tokenizer.apply_chat_template(r["messages"], tokenize=False), add_special_tokens=False)["input_ids"][-MAX_LEN:]},
        remove_columns=ds.column_names,
        new_fingerprint="lolo-trajectories-tokenized",
    )

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,  # TRL >= 0.12 (was tokenizer=)
        train_dataset=ds,
        args=SFTConfig(
            output_dir=out_dir,
            max_length=MAX_LEN,  # TRL >= 0.20 (was max_seq_length)
            per_device_train_batch_size=1,
            gradient_accumulation_steps=8,
            num_train_epochs=epochs,
            learning_rate=1e-4,
            lr_scheduler_type="cosine",
            warmup_ratio=0.05,
            logging_steps=5,
            save_strategy="no",
            bf16=True,
            dataset_num_proc=1,
        ),
    )
    trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")
    trainer.train()

    model.save_pretrained(f"{out_dir}/adapter")
    tokenizer.save_pretrained(f"{out_dir}/adapter")
    model.save_pretrained_merged(f"{out_dir}/merged", tokenizer, save_method="merged_16bit")
    print(f"done: {out_dir}/merged")


# Windows starts worker processes by re-running this file: only the main process trains.
if __name__ == "__main__":
    main()
