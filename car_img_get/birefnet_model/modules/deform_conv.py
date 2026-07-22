import torch
import torch.nn as nn
import torch.nn.functional as F
import os


def _pure_deform_conv2d(input, offset, weight, bias=None, padding=0, mask=None, stride=1):
    """Pure PyTorch deformable convolution for the BiRefNet inference path."""
    pad_h, pad_w = padding if isinstance(padding, tuple) else (padding, padding)
    stride_h, stride_w = stride if isinstance(stride, tuple) else (stride, stride)
    kernel_h, kernel_w = weight.shape[-2:]
    batch, channels, _, _ = input.shape
    out_h, out_w = offset.shape[-2:]
    padded = F.pad(input, (pad_w, pad_w, pad_h, pad_h))
    padded_h, padded_w = padded.shape[-2:]

    base_y = torch.arange(out_h, device=input.device, dtype=input.dtype) * stride_h
    base_x = torch.arange(out_w, device=input.device, dtype=input.dtype) * stride_w
    grid_y, grid_x = torch.meshgrid(base_y, base_x, indexing="ij")
    output = input.new_zeros((batch, weight.shape[0], out_h, out_w))
    for kernel_y in range(kernel_h):
        for kernel_x in range(kernel_w):
            index = kernel_y * kernel_w + kernel_x
            sample_y = grid_y + kernel_y + offset[:, 2 * index]
            sample_x = grid_x + kernel_x + offset[:, 2 * index + 1]
            normalized_y = sample_y * (2.0 / max(1, padded_h - 1)) - 1.0
            normalized_x = sample_x * (2.0 / max(1, padded_w - 1)) - 1.0
            grid = torch.stack((normalized_x, normalized_y), dim=-1)
            sampled = F.grid_sample(padded, grid, mode="bilinear", padding_mode="zeros", align_corners=True)
            if mask is not None:
                sampled = sampled * mask[:, index].unsqueeze(1)
            kernel_weight = weight[:, :, kernel_y, kernel_x]
            output = output + torch.einsum("nchw,oc->nohw", sampled, kernel_weight)
    if bias is not None:
        output = output + bias.view(1, -1, 1, 1)
    return output


def deform_conv2d(input, offset, weight, bias=None, padding=0, mask=None, stride=1):
    backend = str(os.getenv("BIREFNET_DEFORM_BACKEND", "torchvision")).strip().lower()
    if backend != "pure":
        try:
            from torchvision.ops import deform_conv2d as torchvision_deform_conv2d

            return torchvision_deform_conv2d(
                input=input,
                offset=offset,
                weight=weight,
                bias=bias,
                padding=padding,
                mask=mask,
                stride=stride,
            )
        except (ImportError, ModuleNotFoundError, RuntimeError):
            pass
    return _pure_deform_conv2d(input, offset, weight, bias=bias, padding=padding, mask=mask, stride=stride)


class DeformableConv2d(nn.Module):
    def __init__(self,
                 in_channels,
                 out_channels,
                 kernel_size=3,
                 stride=1,
                 padding=1,
                 bias=False):

        super(DeformableConv2d, self).__init__()
        
        assert type(kernel_size) == tuple or type(kernel_size) == int

        kernel_size = kernel_size if type(kernel_size) == tuple else (kernel_size, kernel_size)
        self.stride = stride if type(stride) == tuple else (stride, stride)
        self.padding = padding
        
        self.offset_conv = nn.Conv2d(in_channels,
                                     2 * kernel_size[0] * kernel_size[1],
                                     kernel_size=kernel_size,
                                     stride=stride,
                                     padding=self.padding,
                                     bias=True)

        nn.init.constant_(self.offset_conv.weight, 0.)
        nn.init.constant_(self.offset_conv.bias, 0.)
        
        self.modulator_conv = nn.Conv2d(in_channels,
                                     1 * kernel_size[0] * kernel_size[1],
                                     kernel_size=kernel_size,
                                     stride=stride,
                                     padding=self.padding,
                                     bias=True)

        nn.init.constant_(self.modulator_conv.weight, 0.)
        nn.init.constant_(self.modulator_conv.bias, 0.)

        self.regular_conv = nn.Conv2d(in_channels,
                                      out_channels=out_channels,
                                      kernel_size=kernel_size,
                                      stride=stride,
                                      padding=self.padding,
                                      bias=bias)

    def forward(self, x):
        #h, w = x.shape[2:]
        #max_offset = max(h, w)/4.

        offset = self.offset_conv(x)#.clamp(-max_offset, max_offset)
        modulator = 2. * torch.sigmoid(self.modulator_conv(x))
        
        x = deform_conv2d(
            input=x,
            offset=offset,
            weight=self.regular_conv.weight,
            bias=self.regular_conv.bias,
            padding=self.padding,
            mask=modulator,
            stride=self.stride,
        )
        return x
